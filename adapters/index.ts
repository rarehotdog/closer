// 미검증 — 문서 예시 기반, 실호출 0
// Port factory. Mock is the default; tests exercise mock mode alone. Real mode needs
// MODEL_API_KEY in the server environment and is refused in test processes.
import type { PhotoLibrary } from '../fixtures/photos.ts';
import type { CallDeps } from './responses.ts';
import { createSpark1Port } from './spark1.ts';
import { createSamPort, type MaskDecoder } from './sam.ts';
import { createSpark2Port } from './spark2.ts';
import { createRealTransport, resolveMode, type Mode, type Transport } from './transport.ts';
import { createMockTransport, type MockScript, type MockTransport } from './mock/transport.ts';
import type { Ports } from './types.ts';

export type PortDeps = { sleep: (ms: number) => Promise<void>; nowMs: () => number; nowIso: () => string; decodeMask?: MaskDecoder };

export function portsFromTransport(transport: Transport, source: 'live' | 'mock', deps: PortDeps): Ports {
  const d: CallDeps = { transport, source, sleep: deps.sleep, nowMs: deps.nowMs, nowIso: deps.nowIso };
  return { spark1: createSpark1Port(d), sam: createSamPort({ ...d, decodeMask: deps.decodeMask }), spark2: createSpark2Port(d) };
}

export function createMockPorts(lib: PhotoLibrary, deps: PortDeps, script: MockScript = {}): { ports: Ports; transport: MockTransport } {
  const transport = createMockTransport(lib, script);
  return { ports: portsFromTransport(transport, 'mock', deps), transport };
}

/** Server entry: mock by default; real only with a key (throws RealModeRefused otherwise). */
export function createPortsFromEnv(env: Record<string, string | undefined>, lib: PhotoLibrary, deps: PortDeps): { mode: Mode; ports: Ports } {
  const mode = resolveMode(env);
  if (mode === 'real') return { mode, ports: portsFromTransport(createRealTransport(env), 'live', deps) };
  return { mode, ports: createMockPorts(lib, deps).ports };
}
