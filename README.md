# vMix EmberPlus Bridge

## Overview

The **vMix EmberPlus Bridge** is a Node.js application that acts as a bridge between a vMix instance and EmberPlus clients, such as Lawo's VSM.

 It performs the following functions:

- **Monitors vMix Status:**  
  - **Tally Updates:** Receives a string like `TALLY OK 0121...` where each digit represents the tally state for an input (0 = off, 1 = program, 2 = preview).
  - **ACTS Updates:** Receives individual lines such as:
    - `ACTS OK Recording 1`
    - `ACTS OK MultiCorder 0`
    - `ACTS OK Streaming 1`  
    These indicate the statuses for Recording, MultiCorder, and Streaming respectively.

- **Exposes an EmberPlus Provider Tree:**  
  The tree includes:
  - **Studio Subtree:**
    - **Program Tally** (one boolean per input, up to 32 inputs)
    - **Preview Tally** (one boolean per input, up to 32 inputs)
    - **vMix Connected** flag (boolean)
    - **ACTS Status** subtree with nodes for **Recording**, **MultiCorder**, and **Streaming** (boolean)
  - **Functions Subtree:**  
    Contains the following function nodes:
    - **Auto Mix 1** (sends `FUNCTION CUT`)
    - **Stinger 1** (sends `FUNCTION STINGER1`)
    - **Stinger 2** (sends `FUNCTION STINGER2`)
    - **Stinger 3** (sends `FUNCTION STINGER3`)
    - **Stinger 4** (sends `FUNCTION STINGER4`)
    - **Transition 1** (sends `FUNCTION TRANSITION1`)
    - **Transition 2** (sends `FUNCTION TRANSITION2`)
    - **Transition 3** (sends `FUNCTION TRANSITION3`)
    - **Transition 4** (sends `FUNCTION TRANSITION4`)
  - **Matrices Subtree:**  
    Contains the **vMix Routing Matrix**. Targets are the routable vMix outputs
    (Output 2, 3, 4); sources are the vMix inputs plus Program, Preview, MultiView 1,
    and MultiView 2. Routing a source to a target sends the matching
    `FUNCTION SetOutput<n>` command to vMix. (Output 1 is Program-locked and the
    Fullscreen outputs cannot take an input, so they are not exposed as targets.
    Secondary mixes are not exposed because vMix renders them as black on
    NDI/external outputs.)

- **Function Invocation:**  
  When an EmberPlus function is invoked (via an EmberPlus client), the bridge sends the corresponding vMix command (if the TCP connection is active).

- **Robust Connection Handling:**  
  If the vMix TCP connection fails, the bridge uses a back-off strategy (with delays of 2, 4, 16, then 30 seconds for subsequent attempts) to attempt reconnection. The "vMix Connected" node in the EmberPlus tree reflects the connection status.


## Breaking changes in 2.0.0

The Ember+ tree layout changed, so **consumers must remap**. This was done early
in the project's life, while the impact is small, to settle the structure before
more deployments rely on it. Two changes affect existing addressing:

- **Flatter tally tree.** Each tally input is now a single boolean parameter
  directly under Program/Preview Tally (path `1.1.1.N`), instead of a node
  wrapping a boolean (old path `1.1.1.N.1`). This halves the depth and element
  count of the tally banks.
- **Flatter ACTS Status.** Recording, MultiCorder, and Streaming are now boolean
  parameters directly under ACTS Status (`1.1.4.1` / `.2` / `.3`), instead of a
  wrapper node per status holding a boolean.
- **Routing matrix only exposes what works.** Targets are Output 2-4 (Output 1 is
  Program-locked, Fullscreen outputs cannot take an input); sources are the inputs
  plus Program, Preview, MultiView 1, and MultiView 2, with corrected vMix command
  values. Secondary mixes were tried and dropped (vMix renders them black on those
  outputs).
- **Matrix labels reworked.** Source/target names now live as string parameters
  keyed by signal id under a `Labels` container, addressed by an absolute
  `basePath`, following the Lawo Ruby / Arkona convention. The previous
  per-signal `Label` child parameters and relative `basePath` did not resolve in
  standard consumers and have been removed.

## Requirements

- Node.js (v20 or later recommended; the Docker image uses Node 24 LTS)
- npm (Node Package Manager)

## Installation
### Docker
```docker run -p 9000:9000 -e VMIX_HOST=<your_vmix_host> -e VMIX_PORT=8099 mattlamb99/vmix-emberplus-bridge```
### Locally
1. **Clone the Repository:**

   ```bash
   git clone <repository_url>
   cd <repository_directory>
2. **Install Dependencies:**

   ```bash
   npm install

   This project depends on:

* emberplus-connection
* chalk
# Configuration
By default, the bridge expects the vMix instance to be available on localhost port 8099. If your vMix instance is running on a different host or port, 
set ENV variables ```VMIX_HOST``` and or ```VMIX_PORT```


```
const VMIX_HOST = 'localhost';
const VMIX_PORT = 8099;
```
## Usage
Run the bridge with:

```
node bridge.js
```

The application will:

* Start the EmberPlus server on port 9000.
* Attempt to connect to vMix and subscribe to both TALLY and ACTS updates.
* Update the EmberPlus tree with live data:
* * Tally Updates for Program and Preview tallies.
* * ACTS Updates for Recording, MultiCorder, and Streaming statuses.
* * vMix Connected status.
* Listen for function invocations and, if triggered, send the corresponding commands to vMix.

# EmberPlus Tree Structure
```
vMix
 ├─ Studio
 │    ├─ Program Tally
 │    │      └─ Input 1 ... Input 32 (boolean, one parameter per input)
 │    ├─ Preview Tally
 │    │      └─ Input 1 ... Input 32 (boolean, one parameter per input)
 │    ├─ vMix Connected (boolean)
 │    └─ ACTS Status
 │           ├─ Recording (boolean)
 │           ├─ MultiCorder (boolean)
 │           └─ Streaming (boolean)
 ├─ Functions
 │    ├─ Auto Mix 1 (FUNCTION CUT)
 │    ├─ Stinger 1 (FUNCTION STINGER1)
 │    ├─ Stinger 2 (FUNCTION STINGER2)
 │    ├─ Stinger 3 (FUNCTION STINGER3)
 │    ├─ Stinger 4 (FUNCTION STINGER4)
 │    ├─ Transition 1 (FUNCTION TRANSITION1)
 │    ├─ Transition 2 (FUNCTION TRANSITION2)
 │    ├─ Transition 3 (FUNCTION TRANSITION3)
 │    └─ Transition 4 (FUNCTION TRANSITION4)
 └─ Matrices
       └─ Routing
             ├─ vMix Routing Matrix (targets: Output 2-4; sources: Input 1-21,
             │                       Program, Preview, MultiView 1/2)
             └─ Labels
                   ├─ Targets (one string parameter per target, keyed by signal id)
                   └─ Sources (one string parameter per source, keyed by signal id)
```

The tally inputs are flat boolean parameters: `Program Tally -> Input N` lives at
path `1.1.1.N` (not `1.1.1.N.1`). The matrix label nodes follow the Lawo Ruby /
Arkona convention so consumers such as Lawo VSM and emberviewer resolve the
source/target names.
# vMix TCP API Subscriptions
### TALLY Updates:
Sent using:
``SUBSCRIBE TALLY``

Responses (e.g., ``TALLY OK 0121``...) update the Program and Preview tallies for each input.

### ACTS Updates:
Sent using:
``SUBSCRIBE ACTS``

Responses update the corresponding ACTS statuses for:

* Recording
* MultiCorder
* Streaming

## Function Commands
The following functions send the corresponding commands to vMix when invoked:

| Ember Function |	vMix Command |
| --- | --- |
| Auto Mix 1 | FUNCTION CUT |
|Stinger 1	| FUNCTION STINGER1
|Stinger 2	| FUNCTION STINGER2
|Stinger 3	| FUNCTION STINGER3
|Stinger 4	| FUNCTION STINGER4
|Transition 1 | FUNCTION TRANSITION1
|Transition 2 |	FUNCTION TRANSITION2
|Transition 3 |	FUNCTION TRANSITION3
|Transition 4 |	FUNCTION TRANSITION4

# Error Handling & Reconnection
If the vMix TCP connection is lost:

* The vMix Connected node is updated to false.
* The bridge logs a human-readable error message.
* A reconnection attempt is scheduled with exponential back-off:
* * 2 seconds, then 4 seconds, then 16 seconds, and finally 30 seconds between attempts.
* When the connection is re-established, the vMix Connected node is updated to true and the bridge resubscribes to both TALLY and ACTS updates.

# License
This project is licensed under the MIT License.

# Contributions
Pull requests & help is welcome.

# Acknowledgments
vMix TCP API Documentation
EmberPlus and the EmberPlus Connection Library.
Chalk for colorized logging.