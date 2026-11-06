# Health service structure

Origin: operator-authored architecture-prototype demonstration input.

```plantuml
@startuml
actor Client
component "Startup entry" as Startup
component "Exported HTTP server factory" as Application
component "Real ephemeral-port tests" as Tests
Startup --> Application : create and listen on PORT
Tests --> Application : create and listen on loopback random port
Client --> Application : GET /health or unknown route
@enduml
```
