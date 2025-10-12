/**
 * bridge.js
 * 
 * This file creates an EmberPlus server that exposes a tree with up to 32 vMix inputs,
 * split into two subtrees: one for "Program Tally" and one for "Preview Tally."
 * It also adds two additional status subtrees:
 *   - A boolean node ("vMix Connected") indicating the vMix TCP connection status.
 *   - An "ACTS Status" subtree for Recording, MultiCorder, and Stream      3: new NumberedTreeNodeImpl(
        3,
        new EmberNodeImpl('Matrices', 'Matrices', undefined, true),
        {
          1: createVmixMatrix()
        }
      ) * Additionally, under the "Functions" node, several functions are provided.
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
const xml2js = require('xml2js');

// -------------------------------------------------
// Global variables for vMix connection and state
// -------------------------------------------------
let vmixConnection = null;
let vmixPollInterval = null;
let lastXMLRequest = 0;
let vmixMatrixState = {
  inputs: new Map(),  // Map<number, {title, shortTitle}>
  outputs: new Map(), // Map<string, string> - output name to current source
  pseudoSources: new Map() // Map<string, string> - pseudo sources like Multiview1, etc.
};

// Matrix labeling helpers (element number -> metadata)
const matrixSourceNamesById = new Map();
const matrixSourceMetaById = new Map();
const matrixTargetNamesById = new Map();
const matrixTargetMetaById = new Map();

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

  if (operation !== 'CONNECT') {
    console.log(chalk.yellow(`Ignoring matrix operation ${operation} for ${sourceName} -> ${targetName}`));
    return;
  }

  // Enforce One-to-N semantics: ensure only one active source is reported for this target
  connection.sources = [sourceId];
  connection.source = sourceId;

  console.log(chalk.cyan(`Matrix routing request: ${sourceName} (${sourceId}) -> ${targetName} (${targetId})`));

  let command;

  if (sourceMeta.kind === 'input') {
    const inputNumber = sourceMeta.inputNumber;
    if (targetMeta.kind === 'output') {
      command = `FUNCTION SetOutput${targetMeta.number} Value=Input&Input=${inputNumber}`;
    } else if (targetMeta.kind === 'fullscreen') {
      command = `FUNCTION SetFullscreen${targetMeta.number} Value=Input&Input=${inputNumber}`;
    }
  } else if (sourceMeta.kind === 'pseudo') {
    const pseudoValue = sourceMeta.value;
    if (targetMeta.kind === 'output') {
      command = `FUNCTION SetOutput${targetMeta.number} Value=${pseudoValue}`;
    } else if (targetMeta.kind === 'fullscreen') {
      command = `FUNCTION SetFullscreen${targetMeta.number} Value=${pseudoValue}`;
    }
  }

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

// --- Create Matrix with Proper Names ---
const createVmixMatrixNodes = () => {
  // Source / target names exposed to Ember+ clients
  const sourceNames = [];
  const targetNames = ['Output 1', 'Output 2', 'Output 3', 'Output 4', 'Fullscreen 1', 'Fullscreen 2'];

  // Clear previous metadata
  matrixSourceNamesById.clear();
  matrixSourceMetaById.clear();
  matrixTargetNamesById.clear();
  matrixTargetMetaById.clear();

  for (let i = 1; i <= 21; i++) {
    sourceNames.push(`Input ${i}`);
  }
  sourceNames.push('Multiview 1', 'Multiview 2', 'Main Mix');

  const matrixSourceNodes = {};
  const matrixTargetNodes = {};
  const matrixSourceElementNumbers = [];
  const matrixTargetElementNumbers = [];

  const SOURCE_BASE = 10;
  const TARGET_BASE = 100;

  sourceNames.forEach((name, idx) => {
    const elementNumber = SOURCE_BASE + idx;
    matrixSourceElementNumbers.push(elementNumber);
    matrixSourceNamesById.set(elementNumber, name);

    if (idx < 21) {
      matrixSourceMetaById.set(elementNumber, { kind: 'input', inputNumber: idx + 1 });
    } else {
      const pseudoMap = ['Multiview1', 'Multiview2', 'Output1'];
      matrixSourceMetaById.set(elementNumber, { kind: 'pseudo', value: pseudoMap[idx - 21] });
    }

    matrixSourceNodes[elementNumber] = new NumberedTreeNodeImpl(
      elementNumber,
      new EmberNodeImpl(name, `${name} Source`, undefined, true),
      {
        1: new NumberedTreeNodeImpl(
          1,
          new ParameterImpl(
            ParameterType.String,
            'Label',
            `${name} Label`,
            name,
            undefined,
            undefined,
            ParameterAccess.Read
          )
        )
      }
    );
  });

  targetNames.forEach((name, idx) => {
    const elementNumber = TARGET_BASE + idx;
    matrixTargetElementNumbers.push(elementNumber);
    matrixTargetNamesById.set(elementNumber, name);

    const targetType = name.startsWith('Fullscreen') ? 'fullscreen' : 'output';
    const targetNumber = parseInt(name.match(/\d+$/)?.[0] || `${idx + 1}`, 10);
    matrixTargetMetaById.set(elementNumber, { kind: targetType, number: targetNumber });

    matrixTargetNodes[elementNumber] = new NumberedTreeNodeImpl(
      elementNumber,
      new EmberNodeImpl(name, `${name} Target`, undefined, true),
      {
        1: new NumberedTreeNodeImpl(
          1,
          new ParameterImpl(
            ParameterType.String,
            'Label',
            `${name} Label`,
            name,
            undefined,
            undefined,
            ParameterAccess.Read
          )
        )
      }
    );
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
      targetNames.length,
      sourceNames.length,
      undefined,
      1,
      undefined,
      undefined,
      [
        { basePath: '2', description: 'Targets' },
        { basePath: '3', description: 'Sources' }
      ]
    )
  );

  const targetsContainer = new NumberedTreeNodeImpl(
    2,
    new EmberNodeImpl('Targets', 'Matrix Targets', undefined, true),
    matrixTargetNodes
  );

  const sourcesContainer = new NumberedTreeNodeImpl(
    3,
    new EmberNodeImpl('Sources', 'Matrix Sources', undefined, true),
    matrixSourceNodes
  );

  const routingContainer = new NumberedTreeNodeImpl(
    1,
    new EmberNodeImpl('Routing', 'vMix Routing Matrix', undefined, true),
    {
      1: matrixElementNode,
      2: targetsContainer,
      3: sourcesContainer
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
console.log(chalk.blue('EmberPlus server running on port 9000'));

// -------------------------------------------------
// 2. Connect to vMix TCP API with Exponential Backoff on Error
// -------------------------------------------------

// vMix settings
const VMIX_HOST = process.env.VMIX_HOST || 'localhost';
const VMIX_PORT = process.env.VMIX_PORT ? parseInt(process.env.VMIX_PORT, 10) : 8099;

// -------------------------------------------------
// XML Parsing Functions
// -------------------------------------------------

/**
 * Parses vMix XML status and updates matrix state
 * @param {string} xmlData - Raw XML string from vMix
 */
async function parseVmixXML(xmlData) {
  try {
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlData);
    
    if (!result.vmix) {
      console.warn(chalk.yellow('Invalid XML structure received from vMix'));
      return;
    }
    
    // Clear existing state
    vmixMatrixState.inputs.clear();
    vmixMatrixState.outputs.clear();
    vmixMatrixState.pseudoSources.clear();
    
    // Parse inputs
    if (result.vmix.inputs && result.vmix.inputs[0] && result.vmix.inputs[0].input) {
      for (const input of result.vmix.inputs[0].input) {
        const number = parseInt(input.$.number);
        const title = input.$.title || `Input ${number}`;
        const shortTitle = input.$.shortTitle || title;
        
        vmixMatrixState.inputs.set(number, { title, shortTitle });
      }
      console.log(chalk.cyan(`Parsed ${vmixMatrixState.inputs.size} inputs from XML`));
    }
    
    // Parse outputs (from XML if available, or use defaults)
    const defaultOutputs = ['Output 1', 'Output 2', 'Output 3', 'Output 4', 'Fullscreen 1', 'Fullscreen 2'];
    for (const output of defaultOutputs) {
      vmixMatrixState.outputs.set(output, 'Input 1'); // Default to Input 1
    }
    
    // Add pseudo sources
    vmixMatrixState.pseudoSources.set('Multiview 1', 'Multiview 1');
    vmixMatrixState.pseudoSources.set('Multiview 2', 'Multiview 2');
    vmixMatrixState.pseudoSources.set('Main Mix', 'Output 1');
    
    console.log(chalk.green('Matrix state updated from XML'));
    
    // Rebuild dynamic matrix if needed
    await rebuildDynamicMatrix();
    
  } catch (error) {
    console.error(chalk.red('Error parsing vMix XML:'), error.message);
  }
}

/**
 * Rebuilds the dynamic matrix based on current vMix state
 */
async function rebuildDynamicMatrix() {
  if (!dynamicMatrix) {
    console.log(chalk.blue('Creating initial dynamic matrix...'));
    await createDynamicMatrix();
  } else {
    console.log(chalk.blue('Updating existing matrix sources/targets...'));
    // Update matrix dimensions and labels based on current state
    updateMatrixLabels();
  }
}

/**
 * Creates the dynamic vMix routing matrix
 */
async function createDynamicMatrix() {
  const sources = [];
  const targets = [];
  const connections = {};
  
  // Build sources list: inputs + pseudo sources
  let sourceIndex = 0;
  
  // Add vMix inputs as sources
  for (const [number, input] of vmixMatrixState.inputs) {
    sources.push({
      number: sourceIndex,
      name: input.shortTitle
    });
    sourceIndex++;
  }
  
  // Add pseudo sources
  for (const [name, _] of vmixMatrixState.pseudoSources) {
    sources.push({
      number: sourceIndex,
      name: name
    });
    sourceIndex++;
  }
  
  // Build targets list from outputs
  let targetIndex = 0;
  for (const outputName of vmixMatrixState.outputs.keys()) {
    targets.push({
      number: targetIndex,
      name: outputName
    });
    targetIndex++;
  }
  
  console.log(chalk.cyan(`Matrix: ${sources.length} sources, ${targets.length} targets`));
  
  // Create the matrix
  dynamicMatrix = new NumberedTreeNodeImpl(
    1,
    new MatrixImpl(
      'vMix Routing Matrix',
      sources.map(s => s.number),
      targets.map(t => t.number),
      connections,
      undefined,
      MatrixType.NToN,
      MatrixAddressingMode.NonLinear,
      targets.length,
      sources.length,
      sources.map(s => s.name),
      targets.map(t => t.name)
    )
  );
  
  // Add the dynamic matrix as matrix #2, keeping the test matrix as #1
  const matricesNode = tree[1].children[3];
  
  // Create a new numbered tree node for the vMix matrix
  const vmixMatrixNode = new NumberedTreeNodeImpl(2, dynamicMatrix.contents);
  
  // Add it to the matrices node children
  matricesNode.children[2] = vmixMatrixNode;
  
  console.log(chalk.green('Dynamic matrix created and added to tree'));
}

/**
 * Updates matrix labels without recreating the entire matrix
 */
function updateMatrixLabels() {
  // This would update existing matrix labels
  // For now, we'll just log that an update is needed
  console.log(chalk.blue('Matrix label update requested (not implemented yet)'));
}

/**
 * Starts the XML polling interval
 */
function startXMLPolling() {
  // Clear any existing polling interval
  if (vmixPollInterval) {
    clearInterval(vmixPollInterval);
  }
  
  vmixPollInterval = setInterval(() => {
    if (vmixConnection && vmixConnection.writable) {
      requestXMLUpdate();
    }
  }, 2000); // Poll every 2 seconds
  
  console.log(chalk.blue('XML polling started (2s interval)'));
}

/**
 * Stops the XML polling interval
 */
function stopXMLPolling() {
  if (vmixPollInterval) {
    clearInterval(vmixPollInterval);
    vmixPollInterval = null;
    console.log(chalk.blue('XML polling stopped'));
  }
}

/**
 * Requests XML update from vMix
 */
function requestXMLUpdate() {
  const now = Date.now();
  // Throttle requests to no more than once per 1.8 seconds
  if (vmixConnection && vmixConnection.writable && (now - lastXMLRequest) > 1800) {
    console.log(chalk.yellow('Requesting XML update from vMix...'));
    vmixConnection.write('XML \r\n');
    lastXMLRequest = now;
  }
}


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
    
    // Start XML polling for matrix state - DISABLED (using static matrix)
    // startXMLPolling();
    
    // Get initial XML state - DISABLED (using static matrix)
    // requestXMLUpdate();
  });
  
  // Buffer to accumulate incoming data.
  let dataBuffer = '';
  let xmlBuffer = '';
  let collectingXML = false;
  
  vmixClient.on('data', data => {
    dataBuffer += data.toString();
    
    // Check if we're starting XML collection
    if (!collectingXML && dataBuffer.includes('<vmix>')) {
      console.log(chalk.yellow('Starting XML collection...'));
      collectingXML = true;
      xmlBuffer = '';
      // Extract XML start from buffer
      const xmlStart = dataBuffer.indexOf('<vmix>');
      xmlBuffer = dataBuffer.substring(xmlStart);
      dataBuffer = dataBuffer.substring(0, xmlStart);
    }
    
    // If collecting XML, accumulate data
    if (collectingXML) {
      // Check for end
      if (xmlBuffer.includes('</vmix>')) {
        console.log(chalk.yellow('Complete XML received, processing...'));
        const xmlEnd = xmlBuffer.indexOf('</vmix>') + 7; // Include </vmix>
        const completeXML = xmlBuffer.substring(0, xmlEnd);
        const remaining = xmlBuffer.substring(xmlEnd);
        
        // Process the complete XML
        parseVmixXML(completeXML);
        
        // Reset XML collection and add remaining to dataBuffer
        collectingXML = false;
        xmlBuffer = '';
        dataBuffer = remaining + dataBuffer;
      }
      return; // Skip line processing while collecting XML
    }
    
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
      // Process XML length responses (e.g., "XML 9746")
      else if (line.startsWith('XML ') && line.split(' ').length === 2) {
        const xmlLength = parseInt(line.split(' ')[1]);
        console.log(chalk.yellow(`XML response indicates ${xmlLength} bytes of data coming...`));
        // XML data should follow in the next data chunk
      }
      else {
        console.log(chalk.blue('Other response:'), line);
      }
    }
  });
  
  // Handle connection errors.
  vmixClient.on('error', err => {
    vmixConnection = null;
    stopXMLPolling();
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
    stopXMLPolling();
    let delay = (delayIndex < retryDelays.length) ? retryDelays[delayIndex] : maxRetryDelay;
    console.error(chalk.red('vMix TCP API connection closed.'));
    scheduleReconnect(delay, (delayIndex < retryDelays.length) ? delayIndex + 1 : delayIndex);
  });
}

// Start the connection attempt.
connectToVMix();
