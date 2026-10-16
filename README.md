# Football Imaginarium Online v26

Multiplayer prototype with a shared game state.

- Render hosts the Node.js + WebSocket server.
- The room creator is the authoritative game host.
- Human players send actions to the host.
- The host runs bot logic, scoring, turns and card dealing.
- After every action the host broadcasts one synchronized game state to everyone.
- The lobby supports 1–8 human players plus 3–7 bots.

This is a host-authoritative prototype; the next hardening step would be moving the authoritative game logic entirely to the server.
