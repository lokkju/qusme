/**
 * The agent's side of approval (spec 8.2): an MCP client that starts OAuth at the service, shows
 * the user a code, waits for the approval, redeems the code and calls tools. It talks to the
 * harness's plain listener; URLs keep the service's public origin, which the token is bound to.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect } from '@playwright/test';
import { AGENT_CLIENT_ID, AGENT_REDIRECT, SERVICE_ORIGIN } from '../harness/constants.ts';
import { harness } from './browser.ts';

const RESOURCE = `${SERVICE_ORIGIN}/mcp`;

/** Sends a request for a service URL to the harness, unchanged otherwise. */
function serviceFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), SERVICE_ORIGIN);
  if (url.origin !== SERVICE_ORIGIN) throw new Error(`not a service URL: ${url}`);
  return fetch(`http://127.0.0.1:${harness().plain}${url.pathname}${url.search}`, {
    ...init,
    redirect: 'manual',
  });
}

export interface Authorization {
  /** The code the sign-in page shows, `XXXX-XXXX`. */
  code: string;
  /** Waits for the user's approval and connects to the MCP endpoint. */
  connect(): Promise<Agent>;
}

export interface Agent {
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** Starts OAuth as the test agent: the sign-in page's code, and how to finish. */
export async function startAuthorization(): Promise<Authorization> {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: AGENT_CLIENT_ID,
    redirect_uri: AGENT_REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'e2e',
    resource: RESOURCE,
    scope: 'drafts:submit',
  });
  const start = await serviceFetch(`/authorize?${query}`);
  expect(start.status).toBe(303);
  const page = start.headers.get('Location') ?? '';
  const html = await (await serviceFetch(page)).text();
  const code = /class="code"[^>]*>([0-9A-Z]{4}-[0-9A-Z]{4})</.exec(html)?.[1];
  if (code === undefined) throw new Error('the sign-in page shows no code');

  return {
    code,
    async connect() {
      let redirect = '';
      await expect
        .poll(
          async () => {
            const status = (await (await serviceFetch(`${page}/status`)).json()) as {
              status: string;
              redirect?: string;
            };
            redirect = status.redirect ?? '';
            return status.status;
          },
          { message: 'the sign-in page never redirected', timeout: 30_000 }
        )
        .toBe('redirect');
      const token = await serviceFetch('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: new URL(redirect).searchParams.get('code') ?? '',
          redirect_uri: AGENT_REDIRECT,
          client_id: AGENT_CLIENT_ID,
          code_verifier: verifier,
          resource: RESOURCE,
        }).toString(),
      });
      expect(token.status).toBe(200);
      const { access_token: accessToken } = (await token.json()) as { access_token: string };
      const client = new Client({ name: 'qusme-e2e-agent', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(RESOURCE), {
          fetch: serviceFetch,
          requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
        })
      );
      return {
        call: async (name, args = {}) =>
          (await client.callTool({ name, arguments: args })) as ToolResult,
        close: () => client.close(),
      };
    },
  };
}
