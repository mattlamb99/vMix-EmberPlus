/**
 * parsers.js
 *
 * Pure parsers for the vMix TCP API text protocol. Kept side-effect free so they
 * can be unit-tested against real captured strings without opening a socket.
 */

'use strict';

/**
 * Parse a vMix "TALLY OK ..." line into per-input program/preview booleans.
 *
 * The tally string is one digit per input: 0 = off, 1 = program, 2 = preview.
 * Example: "TALLY OK 0121" -> inputs 1..4.
 *
 * @param {string} line - A full line, e.g. "TALLY OK 0121".
 * @param {number} [maxInputs=32] - Cap the number of inputs returned.
 * @returns {Array<{input:number, state:number, program:boolean, preview:boolean}>}
 *          One entry per input (1-based), or [] for a non-TALLY/invalid line.
 */
function parseTally(line, maxInputs = 32) {
  if (typeof line !== 'string') {
    return [];
  }
  const match = line.match(/^TALLY OK (\d*)/);
  if (!match) {
    return [];
  }
  const digits = match[1];
  const updates = [];
  for (let i = 0; i < digits.length && i < maxInputs; i++) {
    const state = Number(digits.charAt(i));
    updates.push({
      input: i + 1,
      state,
      program: state === 1,
      preview: state === 2
    });
  }
  return updates;
}

/**
 * Parse a vMix "ACTS OK <Category> <Value>" line.
 *
 * Example: "ACTS OK Recording 1" -> { category: 'Recording', active: true }.
 *
 * @param {string} line - A full line, e.g. "ACTS OK Streaming 0".
 * @returns {{category:string, active:boolean}|null} Parsed status, or null if
 *          the line is not a well-formed ACTS update.
 */
function parseActs(line) {
  if (typeof line !== 'string') {
    return null;
  }
  const match = line.match(/^ACTS OK (\S+) (\S+)/);
  if (!match) {
    return null;
  }
  return { category: match[1], active: match[2] === '1' };
}

/**
 * Build the vMix `FUNCTION SetOutputN ...` command for a matrix route, or null if
 * the route is not expressible (e.g. the target is not a routable output).
 *
 * Only vMix Outputs 2-4 are routable; Output 1 is Program-locked and Fullscreen
 * outputs cannot take an input, so those never reach here as `kind: 'output'`.
 *
 * @param {{kind:string, inputNumber?:number, value?:string}} sourceMeta
 * @param {{kind:string, number?:number}} targetMeta
 * @returns {string|null} e.g. "FUNCTION SetOutput2 Value=Input&Input=1"
 */
function buildRouteCommand(sourceMeta, targetMeta) {
  if (!sourceMeta || !targetMeta || targetMeta.kind !== 'output') {
    return null;
  }
  if (sourceMeta.kind === 'input') {
    return `FUNCTION SetOutput${targetMeta.number} Value=Input&Input=${sourceMeta.inputNumber}`;
  }
  if (sourceMeta.kind === 'value') {
    return `FUNCTION SetOutput${targetMeta.number} Value=${sourceMeta.value}`;
  }
  return null;
}

module.exports = { parseTally, parseActs, buildRouteCommand };
