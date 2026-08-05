import type { ResourceType } from "./types";

// The 6 predefined resource types. See README.md for the reasoning behind
// fanRule / taskingConfig.sharing choices made for each. `inspectorRules` gives the
// same rules in prose, for an LLM (or person) reading exported JSON without this file.
export const PREDEFINED_RESOURCE_TYPES: ResourceType[] = [
  {
    id: "rt-wave-switch-10x10",
    name: "Wave Switch 10x10 (Multicast)",
    description:
      "10 wave inputs, 10 wave outputs. Multicast: one input can fan out to many outputs (1:1, 1:2, ... 1:10).",
    ioPorts: [
      { name: "wave", direction: "input", count: 10 },
      { name: "wave", direction: "output", count: 10 },
    ],
    fanRule: "fan-out",
    taskingConfig: {
      fields: [{ name: "key", type: "string" }],
      sharing: "multi",
    },
    inspectorRules: {
      portShape:
        "Multicast switch: any one of the 10 wave inputs may feed multiple wave outputs at once " +
        "(one task per output, 1:1 through 1:10 from a single input). Each wave output can only ever " +
        "be driven by one task at a time — two tasks cannot both claim the same output.",
      taskingConfig:
        "Multiple concurrent 'key' values are allowed on this switch at once — each fan-out group " +
        "can carry its own key, so tasks with different key values do not conflict with each other.",
    },
  },
  {
    id: "rt-digital-switch-1x10",
    name: "Digital Switch 1x10 (Multiplex)",
    description:
      "1 digital input, 10 digital outputs. Multiplexes the single input out to many outputs.",
    ioPorts: [
      { name: "digital", direction: "input", count: 1 },
      { name: "digital", direction: "output", count: 10 },
    ],
    fanRule: "fan-out",
    taskingConfig: {
      fields: [{ name: "key", type: "string" }],
      sharing: "single",
    },
    inspectorRules: {
      portShape:
        "Multiplexes its single digital input out to any number of the 10 digital outputs at once; " +
        "each digital output can only be driven by one task. Because there is only one input port, this " +
        "is mechanically the same fan-out rule as the multicast switch above, applied to a single source.",
      taskingConfig:
        "Only one live 'key' configuration is allowed at a time — every task on this asset, regardless " +
        "of which output it feeds, must carry the same key value, since there is only one input signal " +
        "being multiplexed out.",
    },
  },
  {
    id: "rt-wave-to-digital",
    name: "Wave -> Digital Converter",
    description: "1 wave input, 1 digital output. Converts a wave signal to digital.",
    ioPorts: [
      { name: "wave", direction: "input", count: 1 },
      { name: "digital", direction: "output", count: 1 },
    ],
    fanRule: "strict-one-to-one",
    taskingConfig: {
      fields: [{ name: "key", type: "string" }],
      sharing: "single",
    },
    inspectorRules: {
      portShape:
        "Plain 1:1 converter: the single wave input and single digital output can each serve at most " +
        "one task at a time — no fan-out or fan-in, so at most one task may exist on this asset at all.",
      taskingConfig:
        "Only one live 'key' configuration is allowed — trivially satisfied since at most one task can " +
        "exist on this asset at a time anyway.",
    },
  },
  {
    id: "rt-wave-5x5",
    name: "Wave 5x5",
    description: "5 wave inputs, 5 wave outputs, plain 1:1 lanes (no fan-out/fan-in).",
    ioPorts: [
      { name: "wave", direction: "input", count: 5 },
      { name: "wave", direction: "output", count: 5 },
    ],
    fanRule: "strict-one-to-one",
    taskingConfig: {
      fields: [{ name: "key", type: "string" }],
      sharing: "multi",
    },
    inspectorRules: {
      portShape:
        "5 independent wave lanes: each of the 5 inputs and 5 outputs may serve at most one task, with " +
        "no fan-out or fan-in between lanes — up to 5 concurrent 1:1 tasks total.",
      taskingConfig:
        "Each of the up to 5 concurrent tasks may carry its own 'key' value independently — lanes do " +
        "not need to agree on a shared configuration.",
    },
  },
  {
    id: "rt-wave-source",
    name: "Wave Source",
    description: "1 wave output only. Nothing feeds into it — a signal origin.",
    ioPorts: [{ name: "wave", direction: "output", count: 1 }],
    fanRule: "none",
    taskingConfig: {
      fields: [{ name: "key", type: "string" }],
      sharing: "single",
    },
    inspectorRules: {
      portShape:
        "No switching to validate: this asset only has an output side, so port-shape/fan legality " +
        "does not apply.",
      taskingConfig:
        "Only one live 'key' configuration is allowed — this asset represents a single signal origin.",
    },
  },
  {
    id: "rt-digital-sink",
    name: "Digital Sink",
    description: "1 digital input only. Nothing flows out of it — a signal terminus.",
    ioPorts: [{ name: "digital", direction: "input", count: 1 }],
    fanRule: "none",
    taskingConfig: {
      fields: [{ name: "key", type: "string" }],
      sharing: "single",
    },
    inspectorRules: {
      portShape:
        "No switching to validate: this asset only has an input side, so port-shape/fan legality " +
        "does not apply.",
      taskingConfig:
        "Only one live 'key' configuration is allowed — this asset represents a single signal terminus.",
    },
  },
];

export function getResourceType(id: string): ResourceType | undefined {
  return PREDEFINED_RESOURCE_TYPES.find((rt) => rt.id === id);
}
