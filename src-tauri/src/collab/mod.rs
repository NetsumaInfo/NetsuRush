//! Collaborative projects (`docs/collab.md`).
//!
//! The Rust side is the single authority for collaborative state: it owns the Loro document, the
//! iroh endpoint, durable outbox, blob store and every secret. Renderers receive total board
//! projections and submit typed operations; they never receive key material or mutable CRDT access.

pub mod blobs;
pub mod commands;
pub mod convex;
pub mod crypto;
pub mod device;
pub mod doc;
pub mod error;
pub mod identity;
pub mod ids;
pub mod net;
pub mod ops;
pub mod service;
pub mod store;
