/**
 * 편집 중인 HWPX 한 건.
 *
 * 원본 ZIP을 계속 들고 있다가 수정된 section XML만 갈아끼워 새 파일을 만든다.
 * 이미지, 서식, 나머지 리소스는 압축된 바이트 그대로 옮겨지므로 원본과 동일하다.
 */

import { Stopwatch } from '../perf'
import { parseSection, buildDocumentModel, type DocumentModel } from './document'
import type { ManifestItem } from './manifest'
import { normalizeLayout, type LayoutReport, type LayoutScope } from './layout'
import { applyPlan, type AppliedChange, type EditPlan } from './patch'
import { loadHwpx, type HwpxMeta, type LoadResult } from './package'
import { repackage } from './zip-writer'
import type { ZipArchive } from './zip'

export class HwpxDocument {
  private readonly imageUrls = new Map<string, string>()
  private modelValue: DocumentModel

  private constructor(
    private readonly archive: ZipArchive,
    private readonly sectionBytes: Map<string, Uint8Array>,
    private readonly manifest: Map<string, ManifestItem>,
    readonly meta: HwpxMeta,
    model: DocumentModel,
  ) {
    this.modelValue = model
  }

  static fromLoadResult(result: LoadResult): HwpxDocument {
    return new HwpxDocument(
      result.archive,
      result.sectionBytes,
      result.manifest,
      result.meta,
      result.model,
    )
  }

  static async open(file: File, watch = new Stopwatch()): Promise<{
    document: HwpxDocument
    timings: ReturnType<Stopwatch['report']>
  }> {
    const result = await loadHwpx(file, watch)
    return { document: HwpxDocument.fromLoadResult(result), timings: result.timings }
  }

  get model(): DocumentModel {
    return this.modelValue
  }

  /** 아직 한 번도 수정되지 않았는가. */
  get pristine(): boolean {
    return this.changeLog.length === 0
  }

  private readonly changeLog: AppliedChange[] = []

  get changes(): readonly AppliedChange[] {
    return this.changeLog
  }

  /**
   * 수정 계획을 적용한다. 검증에 실패하면 `PatchError`를 던지고
   * 문서는 전혀 바뀌지 않는다.
   */
  apply(plan: EditPlan): AppliedChange[] {
    const result = applyPlan(this.modelValue, this.sectionBytes, plan)
    for (const [name, bytes] of result.sections) {
      this.sectionBytes.set(name, bytes)
    }
    // 바이트가 바뀌었으니 조각의 오프셋도 달라졌다. 바꾼 section만 다시 읽는다.
    this.modelValue = buildDocumentModel(
      this.modelValue.sections.map((section) =>
        result.sections.has(section.name)
          ? parseSection(this.sectionBytes.get(section.name)!, section.index, section.name)
          : section,
      ),
    )
    this.changeLog.push(...result.changes)
    return [...result.changes]
  }

  /**
   * 수정된 section만 갈아끼운 새 HWPX 바이트.
   *
   * 내보내기 직전에 낡은 줄 배치 캐시를 걷어낸다. 우리가 조판을 다시 하는 것이
   * 아니라 한글이 다시 하게 만드는 것이다(`layout.ts`). 한 글자도 고치지 않은
   * 문서라면 아무것도 하지 않는다 — 그때는 원본과 바이트 단위로 같아야 한다.
   *
   * 걷어낸 뒤 결과를 **다시 파싱해 확인한다.** 문단 수와 각 문단의 글자가
   * 그대로여야 한다. 어긋나면 정규화를 통째로 버리고 정규화 이전 바이트로
   * 돌아간다. 깨진 파일을 성공으로 내려보내지 않는다.
   */
  async toBytes(options: { layout?: LayoutScope | 'off' } = {}): Promise<Uint8Array> {
    const scope = options.layout ?? 'all'
    if (this.pristine || scope === 'off') {
      return repackage(this.archive, this.sectionBytes)
    }

    const edited = [...new Set(this.changeLog.map((change) => change.paragraphId))]
    // 어떤 칸을 어떤 글로 바꿨는지 알려 준다. 표가 페이지를 넘칠지 가늠하는 데 쓴다.
    // 고치기 전 글자가 있어야 "한 줄에 몇 글자"를 잴 수 있다.
    const changes = new Map(
      this.changeLog.map((change) => [
        change.paragraphId,
        { from: change.oldText, to: change.newText },
      ]),
    )
    const { sections, report } = normalizeLayout(
      this.modelValue,
      this.sectionBytes,
      edited,
      scope,
      (id) => changes.get(id),
    )
    this.layoutReportValue = report

    const normalized = new Map(this.sectionBytes)
    for (const [name, bytes] of sections) normalized.set(name, bytes)

    if (!this.textSurvives(normalized)) {
      // 정규화가 문서를 바꿔 놓았다. 있을 수 없는 일이지만, 그때는 안 하는 편이 낫다.
      this.layoutReportValue = {
        clearedParagraphs: 0,
        sections: [],
        removedBytes: 0,
        tablesMadeFlowable: [],
        tablesStillStuck: [],
      }
      return repackage(this.archive, this.sectionBytes)
    }
    return repackage(this.archive, normalized)
  }

  private layoutReportValue: LayoutReport | undefined

  /** 마지막 `toBytes()`에서 줄 배치 캐시를 얼마나 걷어냈는가. */
  get layoutReport(): LayoutReport | undefined {
    return this.layoutReportValue
  }

  /** 정규화 뒤에도 문단과 글자가 그대로인지 확인한다. */
  private textSurvives(candidate: ReadonlyMap<string, Uint8Array>): boolean {
    try {
      for (const section of this.modelValue.sections) {
        const bytes = candidate.get(section.name)
        if (!bytes) return false
        const reparsed = parseSection(bytes, section.index, section.name)
        if (reparsed.paragraphs.length !== section.paragraphs.length) return false
        for (let i = 0; i < reparsed.paragraphs.length; i += 1) {
          if (reparsed.paragraphs[i]!.text !== section.paragraphs[i]!.text) return false
        }
      }
      return true
    } catch {
      return false
    }
  }

  /** 그림 하나를 blob URL로 꺼낸다. 같은 그림은 한 번만 만든다. */
  async imageUrl(binaryItemId: string): Promise<string | undefined> {
    const cached = this.imageUrls.get(binaryItemId)
    if (cached) return cached
    const item = this.manifest.get(binaryItemId)
    if (!item || !this.archive.has(item.href)) return undefined
    const bytes = await this.archive.read(item.href)
    const type = item.mediaType || guessMediaType(item.href)
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
    this.imageUrls.set(binaryItemId, url)
    return url
  }

  dispose(): void {
    for (const url of this.imageUrls.values()) URL.revokeObjectURL(url)
    this.imageUrls.clear()
  }
}

function guessMediaType(href: string): string {
  const extension = href.slice(href.lastIndexOf('.') + 1).toLowerCase()
  switch (extension) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    case 'svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}
