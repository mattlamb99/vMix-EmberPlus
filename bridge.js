/**
 * bridge.js
 * 
 * This file creates an EmberPlus server that exposes a tree with up to 32 vMix inputs,
 * split into two subtrees: one for "Program Tally" and one for "Preview Tally."
 * It also adds two additional status subtrees:
 *   - A boolean node ("vMix Connected") indicating the vMix TCP connection status.
 *   - An "ACTS Status" subtree for Recording, MultiCorder, and Streaming statuses.
 * 
 * Additionally, under the "Functions" node, several functions are provided.
 * When an Ember function is invoked, the code sends the corresponding vMix command.
 * 
 * The vMix TCP API returns tally strings like:
 *    TALLY OK 0121...
 * (where 0 = off, 1 = program, 2 = preview),
 * and ACTS updates like:
 *    ACTS OK Recording 1
 *    ACTS OK MultiCorder 0
 *    ACTS OK Streaming 1
 * (where 1 means active and 0 means inactive).
 * 
 * If the connection to vMix fails, reconnection is attempted using exponential back‑off.
 * Console output is colorized using Chalk.
 */

const chalk = require('chalk');
const { EmberServer, Model } = require('emberplus-connection');
const {
  NumberedTreeNodeImpl,
  EmberNodeImpl,
  ParameterImpl,
  ParameterType,
  EmberFunctionImpl,
  ParameterAccess,
  MatrixImpl,
  MatrixType,
  MatrixAddressingMode
} = Model;
const net = require('net');

// -------------------------------------------------
// Global variable for the current vMix TCP connection
// -------------------------------------------------
let vmixConnection = null;

// -------------------------------------------------
// 1. Set Up the EmberPlus Server and Tree
// -------------------------------------------------

const s = new EmberServer(9000);

// Mapping from function identifier to the command that should be sent to vMix.
const functionCommandMapping = {
  "Auto Mix 1": "FUNCTION CUT",
  "Stinger 1": "FUNCTION STINGER1",
  "Stinger 2": "FUNCTION STINGER2",
  "Stinger 3": "FUNCTION STINGER3",
  "Stinger 4": "FUNCTION STINGER4",
  "Transition 1": "FUNCTION TRANSITION1",
  "Transition 2": "FUNCTION TRANSITION2",
  "Transition 3": "FUNCTION TRANSITION3",
  "Transition 4": "FUNCTION TRANSITION4"
};

s.onInvocation = (emberFunction, invocation) => {
  console.log(chalk.blue('Invocation received:'), emberFunction, invocation);
  
  // Access the actual function details from emberFunction.contents.
  const func = emberFunction.contents;
  const command = functionCommandMapping[func.identifier];
  if (command) {
    if (vmixConnection && vmixConnection.writable) {
      console.log(chalk.green(`Sending command ${command} to vMix`));
      vmixConnection.write(command + "\r\n");
      return { id: invocation.contents.invocation.id, success: true };
    } else {
      console.error(chalk.red(`vMix connection not available. Cannot send ${command} command.`));
      return { id: invocation.contents.invocation.id, success: false, error: "vMix connection not available." };
    }
  }
  
  // Default response for invocations that are not handled.
  return { id: invocation.contents.invocation.id, success: true };
};

s.onSetValue = async (node, value) => {
  console.log(chalk.blue('Set value request for node'), node, chalk.blue('to'), value);
  s.update(node, { value });
  return true;
};

s.onMatrixOperation = (matrix, connections) => {
  console.log(chalk.blue('Matrix operation on matrix'), matrix);
  for (const connection of Object.values(connections)) {
    s.updateMatrixConnection(matrix, connection);
    console.log(chalk.blue('Updated matrix connection:'), connection);
  }
};

// --- Tally Subtrees for Inputs 1-32 ---
const programTallyNodes = {};
const previewTallyNodes = {};

const programTallyTree = {};
const previewTallyTree = {};

for (let i = 1; i <= 32; i++) {
  // Program Tally node for input i.
  const programParameterNode = new NumberedTreeNodeImpl(
    1,
    new ParameterImpl(
      ParameterType.Boolean,
      `Input ${i}`,
      `Input ${i} Program Tally`,
      false,
      undefined,
      undefined,
      ParameterAccess.Read
    )
  );
  const programContainerNode = new NumberedTreeNodeImpl(
    i,
    new EmberNodeImpl(`Input ${i}`, `Input ${i} Program Tally`, undefined, true),
    { 1: programParameterNode }
  );
  programTallyNodes[i] = programParameterNode;
  programTallyTree[i] = programContainerNode;

  // Preview Tally node for input i.
  const previewParameterNode = new NumberedTreeNodeImpl(
    1,
    new ParameterImpl(
      ParameterType.Boolean,
      `Input ${i}`,
      `Input ${i} Preview Tally`,
      false,
      undefined,
      undefined,
      ParameterAccess.Read
    )
  );
  const previewContainerNode = new NumberedTreeNodeImpl(
    i,
    new EmberNodeImpl(`Input ${i}`, `Input ${i} Preview Tally`, undefined, true),
    { 1: previewParameterNode }
  );
  previewTallyNodes[i] = previewParameterNode;
  previewTallyTree[i] = previewContainerNode;
}

// --- New: vMix Connected Node ---
const vmixConnectedParameterNode = new NumberedTreeNodeImpl(
  1,
  new ParameterImpl(
    ParameterType.Boolean,
    'vMix Connected',
    'Indicates if vMix TCP connection is alive',
    false,
    undefined,
    undefined,
    ParameterAccess.Read
  )
);
const vmixConnectedContainerNode = new NumberedTreeNodeImpl(
  3, 
  new EmberNodeImpl('vMix Connected', 'vMix TCP connection status', undefined, true),
  { 1: vmixConnectedParameterNode }
);

// --- New: ACTS Status Subtree ---
// Create parameter nodes for Recording, MultiCorder, and Streaming.
const actsStatusNodes = {};

const actsStatusTree = {
  1: new NumberedTreeNodeImpl(
    1,
    new EmberNodeImpl('Recording', 'Recording status', undefined, true),
    { 1: (actsStatusNodes["Recording"] = new NumberedTreeNodeImpl(
        1,
        new ParameterImpl(
          ParameterType.Boolean,
          'Recording',
          'Recording status',
          false,
          undefined,
          undefined,
          ParameterAccess.Read
        )
      )) }
  ),
  2: new NumberedTreeNodeImpl(
    2,
    new EmberNodeImpl('MultiCorder', 'MultiCorder status', undefined, true),
    { 1: (actsStatusNodes["MultiCorder"] = new NumberedTreeNodeImpl(
        1,
        new ParameterImpl(
          ParameterType.Boolean,
          'MultiCorder',
          'MultiCorder status',
          false,
          undefined,
          undefined,
          ParameterAccess.Read
        )
      )) }
  ),
  3: new NumberedTreeNodeImpl(
    3,
    new EmberNodeImpl('Streaming', 'Streaming status', undefined, true),
    { 1: (actsStatusNodes["Streaming"] = new NumberedTreeNodeImpl(
        1,
        new ParameterImpl(
          ParameterType.Boolean,
          'Streaming',
          'Streaming status',
          false,
          undefined,
          undefined,
          ParameterAccess.Read
        )
      )) }
  )
};

// --- Build Studio Subtree ---
// Keys:
// 1 - Program Tally; 2 - Preview Tally; 3 - vMix Connected; 4 - ACTS Status.
const studioSubtree = {
  1: new NumberedTreeNodeImpl(
    1,
    new EmberNodeImpl('Program Tally', 'Program Tally', undefined, true),
    programTallyTree
  ),
  2: new NumberedTreeNodeImpl(
    2,
    new EmberNodeImpl('Preview Tally', 'Preview Tally', undefined, true),
    previewTallyTree
  ),
  3: vmixConnectedContainerNode,
  4: new NumberedTreeNodeImpl(
    4,
    new EmberNodeImpl('ACTS Status', 'ACTS Status', undefined, true),
    actsStatusTree
  )
};

// --- Functions Subtree ---
const functionsTree = {
  1: new NumberedTreeNodeImpl(
    1,
    new EmberFunctionImpl("Auto Mix 1", "Cut A to B")
  ),
  2: new NumberedTreeNodeImpl(
    2,
    new EmberFunctionImpl("Stinger 1", "Stinger 1")
  ),
  3: new NumberedTreeNodeImpl(
    3,
    new EmberFunctionImpl("Stinger 2", "Stinger 2")
  ),
  4: new NumberedTreeNodeImpl(
    4,
    new EmberFunctionImpl("Stinger 3", "Stinger 3")
  ),
  5: new NumberedTreeNodeImpl(
    5,
    new EmberFunctionImpl("Stinger 4", "Stinger 4")
  ),
  6: new NumberedTreeNodeImpl(
    6,
    new EmberFunctionImpl("Transition 1", "Transition 1")
  ),
  7: new NumberedTreeNodeImpl(
    7,
    new EmberFunctionImpl("Transition 2", "Transition 2")
  ),
  8: new NumberedTreeNodeImpl(
    8,
    new EmberFunctionImpl("Transition 3", "Transition 3")
  ),
  9: new NumberedTreeNodeImpl(
    9,
    new EmberFunctionImpl("Transition 4", "Transition 4")
  )
};

// --- Build the Complete Tree ---
const tree = {
  1: new NumberedTreeNodeImpl(
    1,
    new EmberNodeImpl('vMix', 'vMix to EmberPlus Gateway', undefined, true),
    {
      1: new NumberedTreeNodeImpl(
        1,
        new EmberNodeImpl('Studio', 'Studio', undefined, true),
        studioSubtree
      ),
      2: new NumberedTreeNodeImpl(
        2,
        new EmberNodeImpl('Functions', 'Functions', undefined, true),
        functionsTree
      ),
      3: new NumberedTreeNodeImpl(
        3,
        new EmberNodeImpl('Matrices', 'Matrices', undefined, true),
        {
          1: new NumberedTreeNodeImpl(
            1,
            new MatrixImpl(
              'Test Matrix',
              [1, 2, 3, 4, 5],
              [1, 2, 3, 4, 5],
              {},
              undefined,
              MatrixType.NToN,
              MatrixAddressingMode.NonLinear,
              5,
              5
            )
          )
        }
      )
    }
  )
};

s.init(tree);
console.log(chalk.blue('EmberPlus server running on port 9000'));

// -------------------------------------------------
// 2. Connect to vMix TCP API with Exponential Backoff on Error
// -------------------------------------------------

// vMix settings
const VMIX_HOST = process.env.VMIX_HOST || 'localhost';
const VMIX_PORT = process.env.VMIX_PORT ? parseInt(process.env.VMIX_PORT, 10) : 8099;


// Retry delays (in milliseconds)
const retryDelays = [2000, 4000, 16000]; // 2s, 4s, 16s
const maxRetryDelay = 30000;             // maximum 30s delay for subsequent attempts

/**
 * Global flag to avoid scheduling duplicate reconnect attempts.
 */
let reconnectScheduled = false;

/**
 * Schedules a reconnect attempt after the given delay.
 * @param {number} delay - The delay in milliseconds.
 * @param {number} delayIndex - The current retry index.
 */
function scheduleReconnect(delay, delayIndex) {
  if (!reconnectScheduled) {
    reconnectScheduled = true;
    console.error(chalk.red(`vMix connection lost. Retrying in ${delay / 1000} seconds...`));
    // Update the vMixConnected flag to false before attempting to reconnect.
    s.update(vmixConnectedParameterNode, { value: false });
    setTimeout(() => {
      reconnectScheduled = false;
      connectToVMix(delayIndex);
    }, delay);
  }
}

/**
 * Attempts to connect to the vMix TCP API.
 * @param {number} [delayIndex=0] - The current index into the retryDelays array.
 */
function connectToVMix(delayIndex = 0) {
  console.log(chalk.yellow(`Attempting to connect to vMix TCP API at ${VMIX_HOST}:${VMIX_PORT}...`));
  
  const vmixClient = net.createConnection({ host: VMIX_HOST, port: VMIX_PORT }, () => {
    console.log(chalk.green(`Connected to vMix TCP API at ${VMIX_HOST}:${VMIX_PORT}`));
    // Store the active connection globally.
    vmixConnection = vmixClient;
    // On successful connection, update the vMixConnected flag to true.
    s.update(vmixConnectedParameterNode, { value: true });
    // Reset reconnect flag and delay index on successful connection.
    reconnectScheduled = false;
    delayIndex = 0;
    // Subscribe to both TALLY and ACTS updates.
    vmixClient.write('SUBSCRIBE TALLY\r\n');
    vmixClient.write('SUBSCRIBE ACTS\r\n');
  });
  
  // Buffer to accumulate incoming data.
  let dataBuffer = '';
  
  vmixClient.on('data', data => {
    dataBuffer += data.toString();
    
    // Process each complete line ending in CRLF.
    while (dataBuffer.indexOf('\r\n') !== -1) {
      const lineEndIndex = dataBuffer.indexOf('\r\n');
      let line = dataBuffer.substring(0, lineEndIndex).trim();
      dataBuffer = dataBuffer.substring(lineEndIndex + 2);
      
      console.log(chalk.blue('Received line:'), line);
      
      // Process TALLY lines (e.g., "TALLY OK 0121...")
      if (line.startsWith('TALLY OK')) {
        let tallyString = line.substring(9); // Remove "TALLY OK " (9 characters)
        console.log(chalk.blue('Tally string:'), tallyString);
        
        // Update each input (up to 32) in both subtrees.
        for (let i = 0; i < tallyString.length && i < 32; i++) {
          let digit = tallyString.charAt(i);
          let programValue = (digit === '1');
          let previewValue = (digit === '2');
          
          if (programTallyNodes[i + 1]) {
            console.log(chalk.red(`Updating Input ${i + 1} Program Tally to ${programValue} (digit: ${digit})`));
            s.update(programTallyNodes[i + 1], { value: programValue });
          }
          if (previewTallyNodes[i + 1]) {
            console.log(chalk.green(`Updating Input ${i + 1} Preview Tally to ${previewValue} (digit: ${digit})`));
            s.update(previewTallyNodes[i + 1], { value: previewValue });
          }
        }
      }
      // Process ACTS lines (e.g., "ACTS OK Recording 1")
      else if (line.startsWith('ACTS OK')) {
        // Expected format: "ACTS OK <Category> <Value>"
        const parts = line.split(' ');
        if (parts.length >= 4) {
          const category = parts[2]; // e.g., "Recording", "MultiCorder", "Streaming"
          const valueStr = parts[3];
          const value = (valueStr === '1'); // true if "1", false if "0"
          if (actsStatusNodes[category] !== undefined) {
            console.log(chalk.magenta(`Updating ${category} status to ${value} (value: ${valueStr})`));
            s.update(actsStatusNodes[category], { value: value });
          } else {
            console.log(chalk.yellow(`Unknown ACTS category received: ${category}`));
          }
        } else {
          console.log(chalk.yellow('Malformed ACTS line:'), line);
        }
      }
      else {
        console.log(chalk.blue('Other response:'), line);
      }
    }
  });
  
  // Handle connection errors.
  vmixClient.on('error', err => {
    vmixConnection = null;
    if (err.code === 'ECONNREFUSED') {
      let delay = (delayIndex < retryDelays.length) ? retryDelays[delayIndex] : maxRetryDelay;
      console.error(chalk.red(`vMix is not reachable (connection refused). Error: ${err.message}`));
      scheduleReconnect(delay, (delayIndex < retryDelays.length) ? delayIndex + 1 : delayIndex);
    } else {
      console.error(chalk.red('vMix TCP API connection error:'), err);
    }
  });
  
  // Handle connection closure.
  vmixClient.on('close', () => {
    vmixConnection = null;
    let delay = (delayIndex < retryDelays.length) ? retryDelays[delayIndex] : maxRetryDelay;
    console.error(chalk.red('vMix TCP API connection closed.'));
    scheduleReconnect(delay, (delayIndex < retryDelays.length) ? delayIndex + 1 : delayIndex);
  });
}

// Start the connection attempt.
connectToVMix();
