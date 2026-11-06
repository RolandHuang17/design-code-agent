# Library borrowing: independent acceptance supplement

Origin: operator benchmark supplement, not part of the original architecture documents.

Implement the accompanying library design using Node22/Express/PostgreSQL. Keep the repository concise (roughly12–18 files). Serve the browser through Compose service gateway on container port3000; PostgreSQL service postgres. Two business modules (catalog and loans) may share this deployable service, as the design explicitly allows.

Fixed interface contract for independently reproducible checks:
- GET /health ->200. Serve a usable page at / for listing books, borrowing and returning.
- POST /api/books {title:string,copies:positive integer} ->201 {id,title,availableCopies}.
- GET /api/books/:id ->200 {id,title,availableCopies}; unknown ->404.
- POST /api/loans {bookId,userId:string} ->201 {id,bookId,userId,status:"active"}.
- POST /api/loans/:id/return ->200 with status:"returned"; repeat is idempotent200 without incrementing stock again.
- Copies cannot become negative; no remaining stock ->409. One active loan per (bookId,userId); duplicate ->409. Invalid title, copies, missing IDs ->400.
- PostgreSQL persists books/loans; borrower concurrency and returns update stock in a transaction on one client. GET /api/books and GET /api/loans support the UI.
- This is a local learning demonstration with caller-provided user IDs, not a production authentication design. Do not invent OAuth or claim user identity is authenticated.
- Idempotent schema creation/seed, bounded errors, dependency lockfile, meaningful unit tests and real source build/check command. No in-memory persistence when PostgreSQL is unavailable.
