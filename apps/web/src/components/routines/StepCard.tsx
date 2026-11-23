import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	ChevronsDown,
	ChevronsUp,
	Copy,
	GripVertical,
	Trash2,
} from "lucide-react";

import type { OrderingProblem, RoutineStep } from "@omp-deck/protocol";

import { StepCommonFields } from "./StepCommonFields";
import { STEP_TYPE_BG, renderStepForm } from "./step-form-render";

interface Props {
	/** Stable dnd-kit id; survives reorders and id renames. */
	sortableId: string;
	step: RoutineStep;
	index: number;
	total: number;
	existingIds: string[];
	/** Ordering problems where this step is the reader. */
	problems: OrderingProblem[];
	/** Set on the card a reorder just moved when that reorder introduced `later` problems. */
	reorderWarning?: { problems: OrderingProblem[]; onRevert: () => void };
	onChange: (next: RoutineStep) => void;
	onRemove: () => void;
	onDuplicate: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
}

function describeProblem(p: OrderingProblem): string {
	return p.kind === "later"
		? `reads steps.${p.ref}, which runs later`
		: `reads steps.${p.ref}, but no step has that id`;
}

export function StepCard({
	sortableId,
	step,
	index,
	total,
	existingIds,
	problems,
	reorderWarning,
	onChange,
	onRemove,
	onDuplicate,
	onMoveUp,
	onMoveDown,
}: Props) {
	const [open, setOpen] = useState(true);
	const idsExcludingSelf = existingIds.filter((_id, i) => i !== index);
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
		useSortable({ id: sortableId });
	const problemText = problems.map(describeProblem).join("\n");

	return (
		<div
			ref={setNodeRef}
			style={{ transform: CSS.Translate.toString(transform), transition }}
			className={`rounded border border-line bg-paper-2 ${isDragging ? "relative z-10 opacity-80 shadow-lg" : ""}`}
		>
			<div className="flex items-center gap-1 border-b border-line px-1.5 py-1">
				<button
					type="button"
					ref={setActivatorNodeRef}
					{...attributes}
					{...listeners}
					className="btn-ghost h-6 w-5 cursor-grab touch-none p-0 text-ink-4 hover:text-ink active:cursor-grabbing"
					aria-label={`Reorder step ${step.id}`}
					title="Drag to reorder"
				>
					<GripVertical className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					onClick={() => setOpen((o) => !o)}
					className="btn-ghost h-6 w-6 p-0"
					aria-label={open ? "Collapse" : "Expand"}
				>
					{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
				</button>
				<span className={`rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta ${STEP_TYPE_BG[step.type]}`}>
					{step.type}
				</span>
				<span className="font-mono text-2xs text-ink-2">{step.id || "(no id)"}</span>
				{problems.length > 0 ? (
					<span role="img" className="text-warn" title={problemText} aria-label={problemText}>
						<AlertTriangle className="h-3.5 w-3.5" />
					</span>
				) : null}
				<div className="ml-auto flex items-center gap-0.5">
					<button
						type="button"
						onClick={onMoveUp}
						disabled={index === 0}
						className="btn-ghost h-6 w-6 p-0 disabled:opacity-30"
						aria-label="Move up"
						title="Move up"
					>
						<ChevronsUp className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						onClick={onMoveDown}
						disabled={index === total - 1}
						className="btn-ghost h-6 w-6 p-0 disabled:opacity-30"
						aria-label="Move down"
						title="Move down"
					>
						<ChevronsDown className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						onClick={onDuplicate}
						className="btn-ghost h-6 w-6 p-0"
						aria-label="Duplicate step"
						title="Duplicate"
					>
						<Copy className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						onClick={onRemove}
						className="btn-ghost h-6 w-6 p-0 text-ink-4 hover:text-danger"
						aria-label="Remove step"
						title="Remove"
					>
						<Trash2 className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>
			{reorderWarning ? (
				<div
					role="alert"
					className="flex items-start gap-2 border-b border-warn/40 bg-warn/5 px-2 py-1.5 font-mono text-2xs text-warn"
				>
					<ul className="flex-1 space-y-0.5">
						{reorderWarning.problems.map((p) => (
							<li key={`${p.stepId}:${p.ref}`}>
								{p.stepId} now runs before {p.ref} but reads steps.{p.ref}
							</li>
						))}
					</ul>
					<button type="button" onClick={reorderWarning.onRevert} className="btn-ghost h-6 text-2xs">
						Revert
					</button>
				</div>
			) : null}
			{open ? (
				<div className="space-y-2 p-2">
					<StepCommonFields step={step} onChange={onChange} existingIds={idsExcludingSelf} />
					{renderStepForm(step, onChange)}
				</div>
			) : null}
		</div>
	);
}
