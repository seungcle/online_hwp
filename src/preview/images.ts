/**
 * 미리보기 이미지 지연 로딩.
 *
 * 초기 렌더에서는 `<img>`에 크기만 넣고 `src`는 비워 둔다. 화면에 들어올 때
 * ZIP에서 항목을 꺼내 blob URL을 붙인다. 그래서 이미지가 여러 장이어도
 * 첫 미리보기 속도가 영향을 받지 않는다.
 *
 * 관찰자에만 맡기지는 않는다. 탭이 백그라운드에 있으면 브라우저가 렌더링
 * 기회를 주지 않아 IntersectionObserver 콜백이 아예 돌지 않기 때문이다.
 * 그래서 유휴 시간에 남은 이미지를 한 장씩 채우는 경로를 함께 둔다.
 */

export type ImageLoader = (binaryItemId: string) => Promise<string | undefined>

export interface LazyImageController {
  disconnect(): void
  /** 남은 이미지를 지금 전부 채운다. 인쇄나 내보내기 직전에 쓸 수 있다. */
  loadAll(): Promise<void>
}

const idle = (callback: () => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(callback, { timeout: 2000 })
  else setTimeout(callback, 200)
}

export function attachLazyImages(root: ParentNode, load: ImageLoader): LazyImageController {
  const targets = [...root.querySelectorAll<HTMLImageElement>('img.pv-img[data-image-id]')]
  if (targets.length === 0) {
    return { disconnect: () => {}, loadAll: async () => {} }
  }

  let stopped = false

  const resolve = async (element: HTMLImageElement): Promise<void> => {
    const id = element.dataset['imageId']
    if (stopped || !id || element.dataset['loaded']) return
    element.dataset['loaded'] = '1'
    try {
      const url = await load(id)
      if (url) element.src = url
      else element.classList.add('pv-img--missing')
    } catch {
      element.classList.add('pv-img--missing')
    }
  }

  const loadAll = async (): Promise<void> => {
    for (const element of targets) {
      if (stopped) return
      await resolve(element)
    }
  }

  const observer =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue
              observer?.unobserve(entry.target)
              void resolve(entry.target as HTMLImageElement)
            }
          },
          { rootMargin: '400px' },
        )

  for (const element of targets) observer?.observe(element)

  // 관찰자가 놓친 것을 유휴 시간에 마저 채운다.
  // 첫 미리보기가 이미 그려진 뒤라 체감 속도에 영향을 주지 않는다.
  idle(() => void loadAll())

  return {
    disconnect: () => {
      stopped = true
      observer?.disconnect()
    },
    loadAll,
  }
}
