/**
 * 편집 중인 HWPX 한 건.
 *
 * 원본 ZIP을 계속 들고 있다가 수정된 section XML만 갈아끼워 새 파일을 만든다.
 * 이미지, 서식, 나머지 리소스는 압축된 바이트 그대로 옮겨지므로 원본과 동일하다.
 */

import { Stopwatch } from '../perf'
import { parseSection, buildDocumentModel, type DocumentModel } from './document'
import type { ManifestItem } from './manifest'
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

  /** 수정된 section만 갈아끼운 새 HWPX 바이트. */
  async toBytes(): Promise<Uint8Array> {
    return repackage(this.archive, this.sectionBytes)
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
