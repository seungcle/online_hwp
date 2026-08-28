/** 단계별 소요 시간 측정. 개발 모드와 `?debug=1`에서 화면에 노출된다. */

export interface Lap {
  readonly name: string
  readonly ms: number
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

export class Stopwatch {
  private readonly laps: Lap[] = []
  private readonly startedAt = now()
  private last = this.startedAt

  lap(name: string): void {
    const at = now()
    this.laps.push({ name, ms: at - this.last })
    this.last = at
  }

  /** 이미 끝난 구간을 나중에 끼워 넣을 때 사용한다. */
  record(name: string, ms: number): void {
    this.laps.push({ name, ms })
  }

  get total(): number {
    return now() - this.startedAt
  }

  report(): { laps: Lap[]; total: number } {
    return { laps: [...this.laps], total: this.total }
  }
}

export function formatMs(ms: number): string {
  return ms >= 100 ? `${Math.round(ms)}ms` : `${ms.toFixed(1)}ms`
}
