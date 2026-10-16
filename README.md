# Football Imaginarium Online

Online lobby + WebSocket prototype. This version fixes the start-game transition: the host's settings and bot roster are sent to all clients, and the existing v25 game logic is initialized when the server broadcasts `gameStarting`.

The next development step is full server-authoritative synchronization of turns, cards, clues, votes and scores between human players.
