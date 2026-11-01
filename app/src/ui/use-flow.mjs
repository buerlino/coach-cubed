// A component's view of the flow: re-renders when the flow changes state.
import { useEffect, useState } from 'preact/hooks';

export function useFlow(flow) {
  const [, setChange] = useState(0);
  useEffect(() => flow.subscribe(() => setChange((n) => n + 1)), [flow]);
  return { state: flow.state, params: flow.params };
}
