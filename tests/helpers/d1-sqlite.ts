/**
 * 테스트용 D1. `node:sqlite`로 **실제 SQL을 실행한다.**
 *
 * 가짜 저장소를 만들어 두면 SQL 오타나 제약 조건 실수가 배포까지 살아남는다.
 * D1도 SQLite이므로, 마이그레이션 파일을 그대로 먹이고 같은 쿼리를 돌리면
 * 스키마와 쿼리를 진짜로 검증할 수 있다.
 *
 * 흉내 내는 범위는 `backend/templates.ts`의 `D1Database`가 쓰는 만큼이다.
 * D1의 `?1` 자리표시자는 SQLite도 그대로 이해한다.
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { D1Database, D1PreparedStatement } from '../../backend/templates'

export interface TestD1 extends D1Database {
  /** 저장된 내용을 직접 확인할 때. 개인정보가 새는지 볼 때 쓴다. */
  raw(query: string): unknown[]
  close(): void
}

export function createTestD1(
  migration = resolve('migrations/0001_templates.sql'),
): TestD1 {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(migration, 'utf8'))

  return {
    prepare(query: string): D1PreparedStatement {
      let bound: unknown[] = []
      const statement: D1PreparedStatement = {
        bind(...values: unknown[]) {
          bound = values
          return statement
        },
        async all<T>() {
          // node:sqlite 의 바인딩 타입은 좁다. D1 쪽 계약은 unknown[] 이라 여기서 맞춘다.
          const statement = db.prepare(query) as unknown as {
            all(...values: unknown[]): T[]
          }
          return { results: statement.all(...bound) }
        },
        async run() {
          const statement = db.prepare(query) as unknown as {
            run(...values: unknown[]): unknown
          }
          return statement.run(...bound)
        },
      }
      return statement
    },
    raw(query: string) {
      return db.prepare(query).all()
    },
    close() {
      db.close()
    },
  }
}
