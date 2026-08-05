// Env Studio domain model.
//
// Vocabulary mapping to BUILD_SPEC.md (same domain, renamed lens — see README.md):
//   ResourceType        <-> StationType
//   Asset                <-> Station
//   IOPortGroup / IOPort  <-> Track / TrackDef
//   DataflowConnection    <-> Link
//   Task.taskingConfiguration <-> Task.taskingConfiguration (BUILD_SPEC §3, unchanged)

export type Direction = "input" | "output";

/** A named group of identical ports on a ResourceType, e.g. 10x "wave" inputs. */
export interface IOPortGroup {
  name: string; // ioport name, e.g. "wave" | "digital" — connections require matching names
  direction: Direction;
  count: number; // number of individual ports in this group, indexed 0..count-1
}

/** Reference to one individual port on an asset: group name + index within that group. */
export interface PortRef {
  name: string;
  index: number;
}

/**
 * How an asset's live Tasks are allowed to occupy its input/output ports.
 *
 *   "none"             — no switching: the type has only a source or only a sink side.
 *   "strict-one-to-one"— every used input port and used output port serves exactly one Task
 *                         (plain N-lane pass-through; capacity = min(inputCount, outputCount)).
 *   "fan-out"           — multicast: one input port may feed many Tasks (one per output port
 *                          used), but each output port still serves exactly one Task.
 *   "fan-in"            — multiplex: one output port may be fed by many Tasks (one per input
 *                          port used), but each input port still serves exactly one Task.
 *
 * Note: a type with only one input port (e.g. the 1x10 digital switch) can only ever
 * exercise the fan-out direction mechanically, even though the domain calls that shape
 * "multiplexing" — there is no second input to fan traffic into. See README.md.
 */
export type FanRule = "none" | "strict-one-to-one" | "fan-out" | "fan-in";

export interface TaskingFieldDef {
  name: string;
  type: "string";
}

export interface TaskingConfigSchema {
  fields: TaskingFieldDef[];
  /**
   * "single" — this asset may only have ONE live configuration: every Task on the asset
   *            must carry identical values for every tasking field.
   * "multi"  — this asset supports multiple concurrent Task "shapes": Tasks may carry
   *            different tasking field values from each other with no conflict.
   */
  sharing: "single" | "multi";
}

/**
 * Plain-language explanation of what the Fake Inspector enforces for a given
 * ResourceType, one string per check it runs (see inspector.ts). This is redundant
 * with `fanRule` / `taskingConfig.sharing` for a human who already knows the enum
 * semantics — it exists so an LLM (or a person) reading the exported JSON in
 * isolation, without this source tree, can tell what "INVALID" is supposed to mean
 * for *this* resource type without inferring it from the enum value alone.
 */
export interface InspectorRuleExplanation {
  portShape: string; // what fanRule concretely allows/forbids for this type's ports
  taskingConfig: string; // what sharing concretely allows/forbids for this type's fields
}

export interface ResourceType {
  id: string;
  name: string;
  description: string;
  ioPorts: IOPortGroup[];
  fanRule: FanRule;
  taskingConfig: TaskingConfigSchema;
  inspectorRules: InspectorRuleExplanation;
}

/** One live use of an asset — mirrors BUILD_SPEC Task (input/output track + taskingConfiguration). */
export interface Task {
  id: string;
  assetId: string;
  input: PortRef | null;
  output: PortRef | null;
  taskingConfiguration: Record<string, string>;
}

export interface Asset {
  id: string;
  name: string;
  resourceTypeId: string;
  position: { x: number; y: number };
  tasks: Task[];
}

/** A dataflow connection between two assets' ports — mirrors BUILD_SPEC Link (OUT -> IN). */
export interface DataflowConnection {
  id: string;
  from: { assetId: string; port: PortRef }; // OUT
  to: { assetId: string; port: PortRef }; // IN
}

export interface InspectResult {
  valid: boolean;
  errors: string[];
}
