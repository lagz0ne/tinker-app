import { operation } from "@tinker/core";
import { useData, useRun } from "@tinker/react";
import { counter } from "./state";
import { syncClient } from "@tinker/start/client";
import { updateCounter } from "../transport/counter.functions";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "./ui/card";
const increase = operation({
  label: "counter.increase",
  depends: { sync: syncClient },
  run: async ({ sync }, { random, signal }) => {
    const executionId = random.uuid();
    await sync.execute(executionId, { send: updateCounter, data: { executionId } }, signal);
  },
});
export function Counter() {
  const value = useData(counter);
  const action = useRun(increase);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Shared counter</h2>
        </CardTitle>
        <CardDescription>Everyone can add one. No sign-in needed.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <output aria-label="Counter value" className="text-3xl font-semibold tabular-nums">
          {value}
        </output>
        <Button disabled={action.status === "pending"} onClick={() => action.run()}>
          {action.status === "pending" ? "Waiting for sync…" : "Increase counter"}
        </Button>
        {Boolean(action.error) && (
          <p role="alert" className="text-sm">
            The counter did not finish. Try again.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
