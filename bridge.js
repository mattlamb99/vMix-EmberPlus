/**
 * bridge.js
 * 
 * This file creates an EmberPlus server that exposes a tree with up to 32 vMix inputs,
 * split into two subtrees: one for "Program Tally" and one for "Preview Tally."
 * It also adds two additional status subtrees:
 *   - A boolean node ("vMix Connected") indicating the vMix TCP connection status.
 *   - An "ACTS Status" subtree for Recording, MultiCorder, and Streaming.
 * A "Functions" node exposes several vMix commands, and a "Matrices" node exposes
 * the vMix Routing Matrix (routable outputs as targets; inputs plus
 * Program/Preview/MultiView as sources).
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
 * If the connection to vMix fails, reconnection is attempted using exponential back-off.
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
const { parseTally, parseActs, buildRouteCommand } = require('./parsers');

// -------------------------------------------------
// Global variables for vMix connection and state
// -------------------------------------------------
let vmixConnection = null;

// Matrix labeling helpers (element number -> metadata)
const matrixSourceNamesById = new Map();
const matrixSourceMetaById = new Map();
const matrixTargetNamesById = new Map();
const matrixTargetMetaById = new Map();

// -------------------------------------------------
// 1. Set Up the EmberPlus Server and Tree
// -------------------------------------------------

// Ember+ provider listen port (override with EMBER_PORT).
const EMBER_PORT = process.env.EMBER_PORT ? parseInt(process.env.EMBER_PORT, 10) : 9000;

const s = new EmberServer(EMBER_PORT);

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
  console.log(chalk.blue('Matrix operation on matrix'), matrix.contents.identifier);
  
  if (matrix.contents.identifier === 'vMix Routing Matrix') {
    for (const connection of Object.values(connections)) {
      handleVmixMatrixOperation(connection);
      s.updateMatrixConnection(matrix, connection);
      console.log(chalk.blue('Updated matrix connection:'), connection);
    }
  } else {
    // Handle other matrices
    for (const connection of Object.values(connections)) {
      s.updateMatrixConnection(matrix, connection);
      console.log(chalk.blue('Updated matrix connection:'), connection);
    }
  }
};

/**
 * Handles vMix routing matrix operations
 * @param {Object} connection - The matrix connection object
 */
function handleVmixMatrixOperation(connection) {
  if (!vmixConnection || !vmixConnection.writable) {
    console.error(chalk.red('vMix connection not available for matrix operation'));
    return;
  }

  const targetId = connection.target;
  const targetName = matrixTargetNamesById.get(targetId) || `Target ${targetId}`;
  const targetMeta = matrixTargetMetaById.get(targetId);
  const operation = connection.operation;
  const sources = Array.isArray(connection.sources) ? [...connection.sources] : [];
  if (typeof connection.source === 'number') {
    sources.push(connection.source);
  }
  
  if (sources.length === 0) {
    console.log(chalk.yellow(`No sources provided for matrix operation (${operation}) on ${targetName}`));
    return;
  }

  if (!targetMeta) {
    console.error(chalk.red(`Matrix target metadata missing for element ${targetId}`));
    return;
  }

  if (operation === 'DISCONNECT') {
    console.log(chalk.yellow(`Matrix disconnect request for ${targetName} (${targetId})`));
    connection.sources = [];
    delete connection.source;
    return;
  }

  const sourceId = sources.filter((value) => Number.isInteger(value)).pop();

  if (!Number.isInteger(sourceId)) {
    console.error(chalk.red(`No valid source id resolved for target ${targetName} (${targetId})`));
    return;
  }
  const sourceName = matrixSourceNamesById.get(sourceId) || `Source ${sourceId}`;
  const sourceMeta = matrixSourceMetaById.get(sourceId);

  if (!sourceMeta) {
    console.error(chalk.red(`Matrix source metadata missing for element ${sourceId}`));
    return;
  }

  // Route on CONNECT and ABSOLUTE (and a missing operation, which Ember+ treats as
  // absolute). Consumers setting a One-to-N crosspoint typically send ABSOLUTE, not
  // CONNECT - emberviewer and Lawo VSM both do. Only ignore genuinely unknown ops.
  if (operation && operation !== 'CONNECT' && operation !== 'ABSOLUTE') {
    console.log(chalk.yellow(`Ignoring matrix operation ${operation} for ${sourceName} -> ${targetName}`));
    return;
  }

  // Enforce One-to-N semantics: ensure only one active source is reported for this target
  connection.sources = [sourceId];
  connection.source = sourceId;

  console.log(chalk.cyan(`Matrix routing request: ${sourceName} (${sourceId}) -> ${targetName} (${targetId})`));

  // Targets are routable vMix outputs (SetOutput2/3/4); sources are a specific input
  // (Value=Input&Input=N) or a named value such as Output/Preview/MultiView.
  const command = buildRouteCommand(sourceMeta, targetMeta);

  if (command) {
    console.log(chalk.green(`Sending vMix routing command: ${command}`));
    vmixConnection.write(command + '\r\n');
  } else {
    console.error(chalk.red(`Could not build vMix command for ${sourceName} -> ${targetName}`));
  }
}

// --- Tally Subtrees for Inputs 1-32 ---
const programTallyNodes = {};
const previewTallyNodes = {};

const programTallyTree = {};
const previewTallyTree = {};

// Each input is a single boolean parameter directly under "Program Tally" /
// "Preview Tally" (param number == input number). This keeps the tree shallow:
// Program Tally -> Input N (boolean) at 1.1.1.N, not 1.1.1.N.1.
for (let i = 1; i <= 32; i++) {
  const programParameterNode = new NumberedTreeNodeImpl(
    i,
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
  programTallyNodes[i] = programParameterNode;
  programTallyTree[i] = programParameterNode;

  const previewParameterNode = new NumberedTreeNodeImpl(
    i,
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
  previewTallyNodes[i] = previewParameterNode;
  previewTallyTree[i] = previewParameterNode;
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

// --- ACTS Status Subtree ---
// Recording / MultiCorder / Streaming as flat boolean parameters directly under
// "ACTS Status" (no per-status wrapper node), matching the flat tally layout.
const actsStatusNodes = {};
const actsStatusTree = {};
['Recording', 'MultiCorder', 'Streaming'].forEach((name, idx) => {
  const node = new NumberedTreeNodeImpl(
    idx + 1,
    new ParameterImpl(
      ParameterType.Boolean,
      name,
      `${name} status`,
      false,
      undefined,
      undefined,
      ParameterAccess.Read
    )
  );
  actsStatusNodes[name] = node;
  actsStatusTree[idx + 1] = node;
});

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

// --- Create Matrix with Proper Names ---
const createVmixMatrixNodes = () => {
  // Only Outputs 2-4 are routable on vMix: Output 1 is Program-locked and the
  // Fullscreen outputs cannot take an input. Sources are the vMix inputs plus
  // Program / Preview / MultiView. The `number` (target) and `value` (source)
  // fields drive the vMix command in handleVmixMatrixOperation.
  const INPUT_SOURCE_COUNT = 21; // static; vMix input names are not polled today
  const targets = [
    { name: 'Output 2', number: 2 },
    { name: 'Output 3', number: 3 },
    { name: 'Output 4', number: 4 }
  ];
  // Output sources confirmed to actually render on a live vMix. Mix 2-4 are
  // deliberately excluded: vMix accepts `Value=Mix&Mix=N` and reports `source="Mix"`
  // in its XML, but it renders secondary mixes as BLACK on NDI/external outputs, so
  // they are useless as routable sources here.
  const pseudoSources = [
    { name: 'Program', meta: { kind: 'value', value: 'Output' } },
    { name: 'Preview', meta: { kind: 'value', value: 'Preview' } },
    { name: 'MultiView 1', meta: { kind: 'value', value: 'MultiView' } },
    { name: 'MultiView 2', meta: { kind: 'value', value: 'MultiView2' } }
  ];

  // Clear previous metadata
  matrixSourceNamesById.clear();
  matrixSourceMetaById.clear();
  matrixTargetNamesById.clear();
  matrixTargetMetaById.clear();

  // Label string parameters keyed by signal id. This is the Lawo Ruby / Arkona
  // convention that emberviewer and Lawo VSM resolve: the matrix `labels[].basePath`
  // points (as an ABSOLUTE OID from root) at a container whose "Targets"/"Sources"
  // child nodes hold one string parameter per signal (param number == signal id,
  // value == name). Do NOT wrap each signal in its own node with a child "Label".
  const sourceLabelParams = {};
  const targetLabelParams = {};
  const matrixSourceElementNumbers = [];
  const matrixTargetElementNumbers = [];

  const SOURCE_BASE = 10;
  const TARGET_BASE = 100;

  const makeLabelParam = (elementNumber, name) =>
    new NumberedTreeNodeImpl(
      elementNumber,
      new ParameterImpl(
        ParameterType.String,
        name,
        `${name} label`,
        name,
        undefined,
        undefined,
        ParameterAccess.Read
      )
    );

  // Sources: vMix inputs first, then the pseudo sources.
  let sourceIdx = 0;
  for (let i = 1; i <= INPUT_SOURCE_COUNT; i++) {
    const elementNumber = SOURCE_BASE + sourceIdx++;
    const name = `Input ${i}`;
    matrixSourceElementNumbers.push(elementNumber);
    matrixSourceNamesById.set(elementNumber, name);
    matrixSourceMetaById.set(elementNumber, { kind: 'input', inputNumber: i });
    sourceLabelParams[elementNumber] = makeLabelParam(elementNumber, name);
  }
  pseudoSources.forEach((src) => {
    const elementNumber = SOURCE_BASE + sourceIdx++;
    matrixSourceElementNumbers.push(elementNumber);
    matrixSourceNamesById.set(elementNumber, src.name);
    matrixSourceMetaById.set(elementNumber, src.meta);
    sourceLabelParams[elementNumber] = makeLabelParam(elementNumber, src.name);
  });

  // Targets: routable vMix outputs.
  targets.forEach((target, idx) => {
    const elementNumber = TARGET_BASE + idx;
    matrixTargetElementNumbers.push(elementNumber);
    matrixTargetNamesById.set(elementNumber, target.name);
    matrixTargetMetaById.set(elementNumber, { kind: 'output', number: target.number });
    targetLabelParams[elementNumber] = makeLabelParam(elementNumber, target.name);
  });

  const matrixElementNode = new NumberedTreeNodeImpl(
    1,
    new MatrixImpl(
      'vMix Routing Matrix',
      matrixTargetElementNumbers,
      matrixSourceElementNumbers,
      {},
      undefined,
      MatrixType.OneToN,
      MatrixAddressingMode.NonLinear,
      matrixTargetElementNumbers.length,
      matrixSourceElementNumbers.length,
      undefined,
      1,
      undefined,
      undefined,
      // basePath is an ABSOLUTE OID from root to the Labels container below:
      // vMix(1) / Matrices(3) / Routing(1) / Labels(2).
      [{ basePath: '1.3.1.2', description: 'vMix Routing Labels' }]
    )
  );

  // Labels container: Targets/Sources nodes of string params keyed by signal id.
  const labelsContainer = new NumberedTreeNodeImpl(
    2,
    new EmberNodeImpl('Labels', 'vMix Routing Matrix labels', undefined, true),
    {
      1: new NumberedTreeNodeImpl(
        1,
        new EmberNodeImpl('Targets', 'Matrix target labels', undefined, true),
        targetLabelParams
      ),
      2: new NumberedTreeNodeImpl(
        2,
        new EmberNodeImpl('Sources', 'Matrix source labels', undefined, true),
        sourceLabelParams
      )
    }
  );

  const routingContainer = new NumberedTreeNodeImpl(
    1,
    new EmberNodeImpl('Routing', 'vMix Routing Matrix', undefined, true),
    {
      1: matrixElementNode,
      2: labelsContainer
    }
  );

  return {
    matrixNode: matrixElementNode,
    routingNode: routingContainer
  };
};

const {
  matrixNode: matrixElementNode,
  routingNode: matrixRoutingContainer
} = createVmixMatrixNodes();

const matricesChildren = {
  1: matrixRoutingContainer
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
        matricesChildren
      )
    }
  )
};

s.init(tree);
console.log(chalk.blue(`EmberPlus server running on port ${EMBER_PORT}`));

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
      const line = dataBuffer.substring(0, lineEndIndex).trim();
      dataBuffer = dataBuffer.substring(lineEndIndex + 2);

      // Process TALLY lines (e.g., "TALLY OK 0121...")
      if (line.startsWith('TALLY OK')) {
        for (const { input, program, preview } of parseTally(line)) {
          if (programTallyNodes[input]) {
            s.update(programTallyNodes[input], { value: program });
          }
          if (previewTallyNodes[input]) {
            s.update(previewTallyNodes[input], { value: preview });
          }
        }
      }
      // Process ACTS lines (e.g., "ACTS OK Recording 1")
      else if (line.startsWith('ACTS OK')) {
        const act = parseActs(line);
        if (!act) {
          console.log(chalk.yellow('Malformed ACTS line:'), line);
        } else if (actsStatusNodes[act.category] !== undefined) {
          console.log(chalk.magenta(`Updating ${act.category} status to ${act.active}`));
          s.update(actsStatusNodes[act.category], { value: act.active });
        } else {
          console.log(chalk.yellow(`Unknown ACTS category received: ${act.category}`));
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
