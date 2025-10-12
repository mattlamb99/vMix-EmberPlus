# Copilot Instructions for vMix EmberPlus Bridge

## Project Architecture
- **Single-file Node.js app** (`bridge.js`) acts as a bridge between vMix and EmberPlus clients (e.g., Lawo VSM).
- **EmberPlus Provider Tree** exposes vMix status and control functions to clients. Key subtrees: Studio1A (tallies, connection, ACTS), Functions (vMix commands), Matrices.
- **TCP Communication**: Connects to vMix via TCP, subscribes to TALLY and ACTS updates, parses responses, and updates the EmberPlus tree.
- **Function Invocation**: EmberPlus function nodes trigger vMix commands if TCP connection is active.
- **Robust Connection Handling**: Uses exponential back-off for reconnection (2, 4, 8, 16, 30s) and updates the tree with connection status.

## Developer Workflows
- **Run Locally**: `node bridge.js` (requires Node.js v12+)
- **Docker**: `docker run -p 9000:9000 -e VMIX_HOST=<host> -e VMIX_PORT=8099 mattlamb99/vmix-emberplus-bridge`
- **Dependencies**: Install with `npm install` (uses `emberplus-connection`, `chalk`)
- **Configuration**: Override vMix host/port via `VMIX_HOST` and `VMIX_PORT` environment variables.

## Key Patterns & Conventions
- **TALLY Parsing**: TALLY responses are strings like `TALLY OK 0121...` (0=off, 1=program, 2=preview). Each digit maps to an input's tally state.
- **ACTS Parsing**: ACTS responses are lines like `ACTS OK Recording 1` (boolean status for Recording, MultiCorder, Streaming).
- **EmberPlus Tree Structure**: See README for full tree layout. Studio1A subtree is the main status/control area.
- **Function Mapping**: EmberPlus function nodes map directly to vMix TCP commands (e.g., `FUNCTION CUT`, `FUNCTION STINGER1`).
- **Error Handling**: On TCP disconnect, logs error, updates tree, and schedules reconnection with exponential back-off.

## Integration Points
- **vMix TCP API**: Subscribes to TALLY and ACTS updates, sends function commands.
- **EmberPlus Clients**: Exposes provider tree for status and control; responds to function invocations.

## Examples
- **TALLY Update**: `TALLY OK 0121...` → Update Program/Preview tally nodes for inputs 1-32.
- **ACTS Update**: `ACTS OK Recording 1` → Update Recording status node.
- **Function Invocation**: EmberPlus client triggers "Auto Mix 1" → Bridge sends `FUNCTION CUT` to vMix.

## Key Files
- `bridge.js`: Main application logic, TCP handling, EmberPlus tree definition, command mapping.
- `README.md`: Detailed architecture, tree structure, and developer usage instructions.

---
For questions about unclear patterns or missing conventions, ask the user for clarification or examples from production usage.