import { EventEmitter } from 'node:events';
import type { Server as SocketIOServer } from 'socket.io';
import type {
  ProgressEventPayload,
  SystemAlert,
  UpdateProgressEvent,
} from '@/types';

type SocketSessionRevalidator = () => void;

declare global {
  var __nasSyncEventBus: EventEmitter | undefined;
  var __nasSyncIo: SocketIOServer | undefined;
  var __nasSyncSocketRevalidator: SocketSessionRevalidator | undefined;
}

const ALL_AUTHENTICATED_ROOMS = ['role:ADMIN', 'role:OPERATOR', 'role:VIEWER'];

export function getEventBus(): EventEmitter {
  if (!globalThis.__nasSyncEventBus) {
    const bus = new EventEmitter();
    bus.setMaxListeners(100);
    globalThis.__nasSyncEventBus = bus;
  }
  return globalThis.__nasSyncEventBus;
}

export function attachSocketIO(
  io: SocketIOServer,
  revalidateSessions?: SocketSessionRevalidator
) {
  globalThis.__nasSyncIo = io;
  globalThis.__nasSyncSocketRevalidator = revalidateSessions;
}

export function getSocketIO(): SocketIOServer | undefined {
  return globalThis.__nasSyncIo;
}

function refreshActiveSocketsBeforeBroadcast() {
  try {
    globalThis.__nasSyncSocketRevalidator?.();
  } catch {
    // Ignore transient revalidation errors
  }
}

export function emitJobProgress(payload: ProgressEventPayload) {
  getEventBus().emit('job:progress', payload);
  if (!globalThis.__nasSyncIo) return;
  refreshActiveSocketsBeforeBroadcast();
  globalThis.__nasSyncIo.to(ALL_AUTHENTICATED_ROOMS).emit('job:progress', payload);
}

export function emitJobLog(data: {
  jobId: number;
  serverId: number;
  hostname: string;
  line: string;
  timestamp: string;
}) {
  getEventBus().emit('job:log', data);
  if (!globalThis.__nasSyncIo) return;
  refreshActiveSocketsBeforeBroadcast();
  globalThis.__nasSyncIo.to(ALL_AUTHENTICATED_ROOMS).emit('job:log', data);
}

export function emitJobUpdated(jobId: number) {
  getEventBus().emit('job:updated', { jobId });
  if (!globalThis.__nasSyncIo) return;
  refreshActiveSocketsBeforeBroadcast();
  globalThis.__nasSyncIo
    .to(ALL_AUTHENTICATED_ROOMS)
    .emit('job:updated', { jobId });
}

export function emitVolumeUpdated() {
  getEventBus().emit('volume:updated', {});
  if (!globalThis.__nasSyncIo) return;
  refreshActiveSocketsBeforeBroadcast();
  globalThis.__nasSyncIo.to(ALL_AUTHENTICATED_ROOMS).emit('volume:updated', {});
}

export function emitNewAlert(alert: SystemAlert) {
  getEventBus().emit('alert:new', alert);
  if (!globalThis.__nasSyncIo) return;
  refreshActiveSocketsBeforeBroadcast();
  globalThis.__nasSyncIo.to(ALL_AUTHENTICATED_ROOMS).emit('alert:new', alert);
}

export function emitSystemUpdateProgress(payload: UpdateProgressEvent) {
  getEventBus().emit('system:update_progress', payload);
  if (!globalThis.__nasSyncIo) return;
  refreshActiveSocketsBeforeBroadcast();
  // Tiến trình cập nhật hệ thống chỉ được phát riêng cho quản trị viên (ADMIN)
  globalThis.__nasSyncIo
    .to('role:ADMIN')
    .emit('system:update_progress', payload);
}
