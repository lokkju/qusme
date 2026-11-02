//! NIP-AB interop vectors from block/buzz (see Cargo.toml for how to run it).
//!
//! `generate` prints JSON: the NIP's derivation vectors computed by buzz-core, `nostrpair://`
//! URIs encoded by buzz-core and buzz-core's accept/reject decision on crafted URIs, and signed
//! kind 24134 events whose plaintext is buzz-core's `PairingMessage` serialization, encrypted and
//! signed with the NIP's test vector keys the way buzz-core's `build_event` does it.
//!
//! `check <file>` reads a JSON array written by packages/nostr's `scripts/nip-ab-buzz-events.ts`:
//! for `{ "name", "recipient_privkey", "event" }` it verifies the event, decrypts it with nostr's
//! NIP-44 and parses it as buzz-core's `PairingMessage`; for `{ "name", "uri" }` it runs
//! buzz-core's `decode_qr`. It prints what buzz-core made of each and fails if any is refused.

use buzz_core::pairing::crypto::{derive_sas, derive_session_id, derive_transcript_hash, format_sas};
use buzz_core::pairing::qr::{decode_qr, encode_qr, QrPayload};
use buzz_core::pairing::{AbortReason, PairingMessage, PayloadType};
use nostr::nips::nip44;
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, SecretKey, Tag, Timestamp, ToBech32};
use serde_json::{json, Value};

const SESSION_SECRET: &str = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const SOURCE_PRIVKEY: &str = "7f4c11a9c9d1e3b5a7f2e4d6c8b0a2f4e6d8c0b2a4f6e8d0c2b4a6f8e0d2c4b5";
const TARGET_PRIVKEY: &str = "3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b";
/// NIP-49's example: the key 3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683
/// under the password "nostr" at log_n 16.
const NCRYPTSEC: &str = "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p";
const NCRYPTSEC_KEY: &str = "3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683";
const CREATED_AT: u64 = 1_761_400_000;

fn bytes32(hex_str: &str) -> [u8; 32] {
    hex::decode(hex_str).expect("hex").try_into().expect("32 bytes")
}

fn keys(hex_str: &str) -> Keys {
    Keys::new(SecretKey::from_slice(&bytes32(hex_str)).expect("secret key"))
}

/// buzz-core's `PairingSession::build_event`, with a fixed `created_at` instead of jitter.
fn build_event(sender: &Keys, recipient: &Keys, message: &PairingMessage) -> Value {
    let plaintext = serde_json::to_string(message).expect("serialize");
    let content = nip44::encrypt(
        sender.secret_key(),
        &recipient.public_key(),
        &plaintext,
        nip44::Version::V2,
    )
    .expect("nip44");
    let event = EventBuilder::new(Kind::Custom(24134), &content)
        .tags([Tag::public_key(recipient.public_key())])
        .custom_created_at(Timestamp::from(CREATED_AT))
        .sign_with_keys(sender)
        .expect("sign");
    json!({ "plaintext": plaintext, "event": serde_json::to_value(&event).expect("event") })
}

fn generate() {
    let secret = bytes32(SESSION_SECRET);
    let source = keys(SOURCE_PRIVKEY);
    let target = keys(TARGET_PRIVKEY);

    let session_id = derive_session_id(&secret);
    let ecdh = nostr::util::generate_shared_key(source.secret_key(), &target.public_key())
        .expect("ecdh");
    let (sas_code, sas_input) = derive_sas(&ecdh, &secret);
    let transcript_hash = derive_transcript_hash(
        &session_id,
        &source.public_key().to_bytes(),
        &target.public_key().to_bytes(),
        &sas_input,
        &secret,
    );

    let uris: Vec<Value> = [
        vec!["wss://relay.example.com".to_string()],
        vec![
            "wss://nos.lol".to_string(),
            "wss://relay.ditto.pub/".to_string(),
            "ws://localhost:7777/path?x=1&y=2#frag".to_string(),
        ],
    ]
    .into_iter()
    .map(|relays| {
        let uri = encode_qr(&QrPayload {
            source_pubkey: source.public_key(),
            session_secret: secret,
            relays: relays.clone(),
            version: 1,
        });
        json!({ "relays": relays, "uri": uri })
    })
    .collect();

    let pk = source.public_key().to_hex();
    let relay = "wss%3A%2F%2Frelay.example.com";
    let zeros = "0".repeat(64);
    let candidates: Vec<String> = vec![
        format!("nostrpair://{pk}?secret={SESSION_SECRET}&relay={relay}&v=1"),
        format!("nostrpair://{pk}?secret={SESSION_SECRET}&relay={relay}"),
        format!("nostrpair://{pk}?relay={relay}&secret={SESSION_SECRET}&v=1&mode=recover&x"),
        format!("nostrpair://{pk}?secret={SESSION_SECRET}&relay=wss://relay.example.com&v=1"),
        format!("nostrpair://{pk}?secret={SESSION_SECRET}&relay={relay}&v=2"),
        format!("nostrpair://{pk}?secret={SESSION_SECRET}&v=1"),
        format!("nostrpair://{pk}?relay={relay}&v=1"),
        format!("nostrpair://{pk}?secret={zeros}&relay={relay}&v=1"),
        format!("nostrpair://{}?secret={SESSION_SECRET}&relay={relay}&v=1", pk.to_uppercase()),
        format!("nostrpair://{pk}?secret={}&relay={relay}&v=1", SESSION_SECRET.to_uppercase()),
        format!("nostrpair://{}?secret={SESSION_SECRET}&relay={relay}&v=1", &pk[..62]),
        format!("nostrpair://{pk}?secret={}&relay={relay}&v=1", &SESSION_SECRET[..62]),
        format!("nostrpair://{pk}?secret={SESSION_SECRET}&relay=https%3A%2F%2Frelay.example.com&v=1"),
        format!("nostrpair://{pk}?secret={SESSION_SECRET}&relay=relay.example.com&v=1"),
        format!("nostrpair://{pk}"),
        format!("nostr://{pk}?secret={SESSION_SECRET}&relay={relay}&v=1"),
        // x-coordinate not on the curve
        format!("nostrpair://{}?secret={SESSION_SECRET}&relay={relay}&v=1", "f".repeat(64)),
        format!("nostrpair://{pk}?secret={SESSION_SECRET}&relay={relay}&v=1&pad={}", "a".repeat(2000)),
    ];
    let qr_cases: Vec<Value> = candidates
        .into_iter()
        .map(|uri| match decode_qr(&uri) {
            Ok(qr) => json!({ "uri": uri, "ok": true, "relays": qr.relays }),
            Err(e) => json!({ "uri": uri, "ok": false, "error": e.to_string() }),
        })
        .collect();

    let offer = PairingMessage::Offer {
        session_id: hex::encode(session_id),
        version: 1,
        confirmation: None,
    };
    let offer_desktop_code = PairingMessage::Offer {
        session_id: hex::encode(session_id),
        version: 1,
        confirmation: Some("desktop-code-v1".to_string()),
    };
    let offer_bad_session = PairingMessage::Offer {
        session_id: "00".repeat(32),
        version: 1,
        confirmation: None,
    };
    let sas_confirm = PairingMessage::SasConfirm {
        transcript_hash: hex::encode(transcript_hash),
    };
    let sas_confirm_bad = PairingMessage::SasConfirm {
        transcript_hash: "00".repeat(32),
    };
    let payload = PairingMessage::Payload {
        payload_type: PayloadType::Nsec,
        payload: NCRYPTSEC.to_string(),
    };
    let payload_nsec = PairingMessage::Payload {
        payload_type: PayloadType::Nsec,
        payload: SecretKey::from_hex(NCRYPTSEC_KEY).expect("key").to_bech32().expect("nsec"),
    };
    let payload_custom = PairingMessage::Payload {
        payload_type: PayloadType::Custom,
        payload: "{\"app\":\"com.example\",\"version\":1,\"data\":\"x\"}".to_string(),
    };

    let out = json!({
        "buzz_rev": "8f83c6320994be69f486ba42bf69cea6d8bb9df8",
        "session_secret": SESSION_SECRET,
        "source_privkey": SOURCE_PRIVKEY,
        "source_pubkey": source.public_key().to_hex(),
        "target_privkey": TARGET_PRIVKEY,
        "target_pubkey": target.public_key().to_hex(),
        "ncryptsec": NCRYPTSEC,
        "derivations": {
            "session_id": hex::encode(session_id),
            "ecdh_shared": hex::encode(ecdh),
            "sas_input": hex::encode(sas_input),
            "sas_code": format_sas(sas_code),
            "transcript_hash": hex::encode(transcript_hash),
        },
        "uris": uris,
        "qr_cases": qr_cases,
        "to_source": {
            "offer": build_event(&target, &source, &offer),
            "offer_desktop_code": build_event(&target, &source, &offer_desktop_code),
            "offer_bad_session": build_event(&target, &source, &offer_bad_session),
            "complete": build_event(&target, &source, &PairingMessage::Complete { success: true }),
            "complete_failed": build_event(&target, &source, &PairingMessage::Complete { success: false }),
            "abort_user_denied": build_event(&target, &source, &PairingMessage::Abort { reason: AbortReason::UserDenied }),
            "abort_sas_mismatch": build_event(&target, &source, &PairingMessage::Abort { reason: AbortReason::SasMismatch }),
        },
        "to_target": {
            "sas_confirm": build_event(&source, &target, &sas_confirm),
            "sas_confirm_bad": build_event(&source, &target, &sas_confirm_bad),
            "payload": build_event(&source, &target, &payload),
            "payload_nsec": build_event(&source, &target, &payload_nsec),
            "payload_custom": build_event(&source, &target, &payload_custom),
            "abort_timeout": build_event(&source, &target, &PairingMessage::Abort { reason: AbortReason::Timeout }),
        },
    });
    println!("{}", serde_json::to_string_pretty(&out).expect("json"));
}

fn check(path: &str) {
    let text = std::fs::read_to_string(path).expect("read");
    let items: Vec<Value> = serde_json::from_str(&text).expect("json");
    let mut failed = false;
    for item in items {
        let name = item["name"].as_str().unwrap_or("?").to_string();
        if let Some(uri) = item["uri"].as_str() {
            match decode_qr(uri) {
                Ok(qr) => println!("ok   {name}: relays {:?}", qr.relays),
                Err(e) => {
                    failed = true;
                    println!("FAIL {name}: {e}");
                }
            }
            continue;
        }
        let recipient = keys(item["recipient_privkey"].as_str().expect("recipient_privkey"));
        let result = (|| -> Result<PairingMessage, String> {
            let event = Event::from_json(item["event"].to_string()).map_err(|e| e.to_string())?;
            event.verify().map_err(|e| e.to_string())?;
            if event.kind != Kind::Custom(24134) {
                return Err(format!("kind {}", event.kind.as_u16()));
            }
            let plaintext = nip44::decrypt(recipient.secret_key(), &event.pubkey, &event.content)
                .map_err(|e| e.to_string())?;
            serde_json::from_str::<PairingMessage>(&plaintext).map_err(|e| e.to_string())
        })();
        match result {
            Ok(message) => println!("ok   {name}: {message:?}"),
            Err(e) => {
                failed = true;
                println!("FAIL {name}: {e}");
            }
        }
    }
    if failed {
        std::process::exit(1);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("generate") => generate(),
        Some("check") => check(args.get(2).expect("check <file>")),
        _ => {
            eprintln!("usage: nip-ab-buzz generate | check <file>");
            std::process::exit(2);
        }
    }
}
