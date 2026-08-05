import type { InspectResult, PortRef, ResourceType, Task } from "./types";

/**
 * Fake Inspector: mirrors BUILD_SPEC's Inspector SPI (setup, tasking+candidate, request,
 * liveData) -> full Task[] | fail, simplified to just "given the Task[] currently on an
 * asset, are they mutually valid for this ResourceType?"
 *
 * Two independent checks, matched to how the user described the domain:
 *   1. Tasking configuration consistency (single- vs multi-live-configuration).
 *   2. Port shape / fan legality (strict 1:1, multicast fan-out, multiplex fan-in).
 */
export class FakeInspector {
  constructor(private resourceType: ResourceType) {}

  inspect(tasks: Task[]): InspectResult {
    const errors = [
      ...this.checkTaskingConfig(tasks),
      ...this.checkPortShape(tasks),
    ];
    return { valid: errors.length === 0, errors };
  }

  private checkTaskingConfig(tasks: Task[]): string[] {
    const errors: string[] = [];
    const { fields, sharing } = this.resourceType.taskingConfig;

    for (const task of tasks) {
      for (const field of fields) {
        const value = task.taskingConfiguration[field.name];
        if (value === undefined || value === "") {
          errors.push(
            `Task ${task.id}: missing required tasking config field "${field.name}"`
          );
        }
      }
    }

    if (sharing === "single" && tasks.length > 1) {
      const [baseline, ...rest] = tasks;
      for (const field of fields) {
        const baselineValue = baseline.taskingConfiguration[field.name];
        for (const task of rest) {
          const value = task.taskingConfiguration[field.name];
          if (value !== baselineValue) {
            errors.push(
              `Task ${task.id} has ${field.name}=${value ?? "(unset)"}, conflicts with ` +
                `Task ${baseline.id} ${field.name}=${baselineValue ?? "(unset)"} — ` +
                `${this.resourceType.name} allows only one live configuration`
            );
          }
        }
      }
    }

    return errors;
  }

  private checkPortShape(tasks: Task[]): string[] {
    const errors: string[] = [];
    const { fanRule, ioPorts } = this.resourceType;

    const inputGroups = ioPorts.filter((p) => p.direction === "input");
    const outputGroups = ioPorts.filter((p) => p.direction === "output");

    const portKey = (p: PortRef) => `${p.name}#${p.index}`;

    for (const task of tasks) {
      if (task.input) {
        const group = inputGroups.find((g) => g.name === task.input!.name);
        if (!group) {
          errors.push(`Task ${task.id}: no input ioport named "${task.input.name}" on ${this.resourceType.name}`);
        } else if (task.input.index < 0 || task.input.index >= group.count) {
          errors.push(
            `Task ${task.id}: input port ${portKey(task.input)} out of range (0..${group.count - 1})`
          );
        }
      }
      if (task.output) {
        const group = outputGroups.find((g) => g.name === task.output!.name);
        if (!group) {
          errors.push(`Task ${task.id}: no output ioport named "${task.output.name}" on ${this.resourceType.name}`);
        } else if (task.output.index < 0 || task.output.index >= group.count) {
          errors.push(
            `Task ${task.id}: output port ${portKey(task.output)} out of range (0..${group.count - 1})`
          );
        }
      }
    }

    if (fanRule === "none") {
      return errors;
    }

    const inputUsage = new Map<string, Task[]>();
    const outputUsage = new Map<string, Task[]>();
    for (const task of tasks) {
      if (task.input) {
        const key = portKey(task.input);
        inputUsage.set(key, [...(inputUsage.get(key) ?? []), task]);
      }
      if (task.output) {
        const key = portKey(task.output);
        outputUsage.set(key, [...(outputUsage.get(key) ?? []), task]);
      }
    }

    const forbidRepeat = (
      usage: Map<string, Task[]>,
      side: "input" | "output"
    ) => {
      for (const [key, ts] of usage) {
        if (ts.length > 1) {
          errors.push(
            `${side} port ${key} used by ${ts.length} tasks (${ts.map((t) => t.id).join(", ")}) — ` +
              `${this.resourceType.name} does not allow sharing a ${side} port this way`
          );
        }
      }
    };

    if (fanRule === "strict-one-to-one") {
      forbidRepeat(inputUsage, "input");
      forbidRepeat(outputUsage, "output");
    } else if (fanRule === "fan-out") {
      // multicast: one input -> many outputs; each output still serves one task
      forbidRepeat(outputUsage, "output");
    } else if (fanRule === "fan-in") {
      // multiplex: one output <- many inputs; each input still serves one task
      forbidRepeat(inputUsage, "input");
    }

    return errors;
  }
}

export function inspectAssetTasks(resourceType: ResourceType, tasks: Task[]): InspectResult {
  return new FakeInspector(resourceType).inspect(tasks);
}
