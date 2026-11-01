/**
 * @file automation.ts — @myoxus/env
 *
 * Type definitions for declarative automation actions.
 *
 * An `Action` describes a single automation step: its human-readable metadata,
 * a Zod schema for validated input, and the function that performs the work.
 *
 * Consumers: automation / command-palette subsystems in `client/web`.
 */

import type { z } from "zod";

/**
 * Describes a single automation action with typed, schema-validated input.
 *
 * @template InputSchema - Zod schema that validates the action's input.
 * @template Args        - Additional positional arguments forwarded to the action
 *                         function (beyond the validated input).
 */
export type Action<
  InputSchema extends z.ZodObject<any, any, any, any>,
  Args extends readonly any[],
> = {
  id: string;
  name: string;
  description: string;
  inputSchema: InputSchema;
  action: (input: z.input<InputSchema>, ...args: Args) => void;
};
