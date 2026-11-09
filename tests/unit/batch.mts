// Builds batchexecute response bodies for the unit tests, in the layout
// gemini.google.com sends with rt=c: the )]}' guard, then length-prefixed
// chunks of JSON, one per line. Every id and title here is made up.

// One RPC result frame, its payload JSON-encoded into slot 2.
export function wrb(rpcid: string, payload: unknown): unknown[] {
  return ['wrb.fr', rpcid, JSON.stringify(payload), null, null, null, 'generic'];
}

// A failed RPC: no payload string, the status code in slot 5. The shape
// follows the batchexecute error envelope as published; the structure capture
// on the test account is what confirms it for MaZiqc.
export function wrbError(rpcid: string, code: number): unknown[] {
  return ['wrb.fr', rpcid, null, null, null, [code], 'generic'];
}

export function batchResponse(...frames: unknown[][]): string {
  const chunk = JSON.stringify([...frames, ['di', 87], ['af.httprm', 86, '-1234567890', 4]]);
  const tail = JSON.stringify([['e', 4, null, null, chunk.length + 2]]);
  return `)]}'\n\n${chunk.length}\n${chunk}\n${tail.length}\n${tail}\n`;
}

// A list entry in the ten-position layout of a real MaZiqc page: id, title,
// three nulls, [seconds, nanos] of the last message, three nulls, a flag.
export function listEntry(n: number, seconds: number): unknown[] {
  return [chatId(n), `Title ${n}`, null, null, null, [seconds, 457522000], null, null, null, 1];
}

export function chatId(n: number): string {
  return `c_${n.toString(16).padStart(16, '0')}`;
}
