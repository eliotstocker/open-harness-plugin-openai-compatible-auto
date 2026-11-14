declare module "react" {
  export type Key = string | number | null
  export type ReactNode =
    | ReactElement
    | string
    | number
    | boolean
    | null
    | undefined
    | Iterable<ReactNode>

  export interface ReactElement {
    type: unknown
    props: Record<string, unknown>
    key: Key
  }

  export function createElement(
    type: string | ((props: any) => ReactNode),
    props?: Record<string, unknown> | null,
    ...children: ReactNode[]
  ): ReactElement

  export function useState<S>(initialState: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useRef<T>(initialValue: T): { current: T }
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]): T
}
