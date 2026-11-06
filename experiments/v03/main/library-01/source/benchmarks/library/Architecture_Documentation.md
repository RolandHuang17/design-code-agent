# Library borrowing architecture

## Scope and requirements
Create a local browser application for a small library. Users list books and available copies, borrow a book using an explicitly entered reader ID, and return a loan. The frontend provides clear success/error feedback. Reader IDs are demonstration inputs, not authenticated identities.

FR1: A librarian can create a title with a positive number of copies.
FR2: Readers can see the remaining copies and borrow an available book.
FR3: A reader has at most one active loan for the same book. A different reader may borrow another copy.
FR4: Returning a loan restores one copy; repeated/concurrent returns never increase inventory more than once.
FR5: Invalid input is rejected. Insufficient copies and duplicate active loans are conflicts. Missing records are not found.
NFR1: Eight simultaneous borrowers of the only copy must yield exactly one successful loan; inventory never becomes negative.
NFR2: Books, stock and loans survive application restart, using PostgreSQL16.

## Architecture and deployment
Use Node.js22 and Express, plain HTML/CSS/JavaScript and PostgreSQL. Catalog and loan management are separate business modules inside one deployable gateway service for this small case. Do not copy a game application. No OAuth, queue, search engine or cloud deployment is required.

The Docker Compose services are gateway (container3000) and postgres (container5432). The gateway serves browser UI at / and health at /health. Bootstrap schema idempotently. Database changes for borrowing/returning must use transactions and row locks on a single client. Repeated startup must not overwrite user-created books.

## REST interface
POST /api/books {title,copies} ->201 {id,title,availableCopies}.
GET /api/books ->200 {books:[...]}; GET /api/books/:id ->200 book or404.
POST /api/loans {bookId,userId} ->201 {id,bookId,userId,status:"active"} or409.
GET /api/loans ->200 {loans:[...]}.
POST /api/loans/:id/return ->200 returned loan, idempotent on repetition.
Invalid title/copies/identifiers ->400. Document these endpoints in OpenAPI.

## Delivery
Provide source modules, tests, pinned npm dependencies, Dockerfile/Compose, schema, a working page, README, plan and source-to-code/test traceability. Build must actually check sources. Distinguish tests using fake infrastructure from real runtime acceptance.
