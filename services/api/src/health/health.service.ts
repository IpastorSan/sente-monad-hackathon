import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
}

@Injectable()
export class HealthService {
  check(): HealthStatus {
    return { status: 'ok' };
  }
}
