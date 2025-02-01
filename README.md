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
  - **Studio1A Subtree:**
    - **Program Tally** (for up to 32 inputs)
    - **Preview Tally** (for up to 32 inputs)
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
    Contains an example matrix.

- **Function Invocation:**  
  When an EmberPlus function is invoked (via an EmberPlus client), the bridge sends the corresponding vMix command (if the TCP connection is active).

- **Robust Connection Handling:**  
  If the vMix TCP connection fails, the bridge uses an exponential back-off strategy (with delays of 2, 4, 16, then 30 seconds) to attempt reconnection. The "vMix Connected" node in the EmberPlus tree reflects the connection status.


## Requirements

- Node.js (v12 or later recommended)
- npm (Node Package Manager)

## Installation

1. **Clone the Repository:**

   ```bash
   git clone <repository_url>
   cd <repository_directory>
2. **Install Dependencies:**

   ```bash
   npm install

   This project depends on:

emberplus-connection
chalk
Configuration
By default, the bridge expects the vMix instance to be available on localhost port 8099. If your vMix instance is running on a different host or port, update the following constants in bridge.js:


```
const VMIX_HOST = 'localhost';
const VMIX_PORT = 8099;
```
Usage
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
 ├─ Studio1A
 │    ├─ Program Tally
 │    │      └─ Input 1 … Input 32 (boolean values)
 │    ├─ Preview Tally
 │    │      └─ Input 1 … Input 32 (boolean values)
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
       └─ Test Matrix (example)
```
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