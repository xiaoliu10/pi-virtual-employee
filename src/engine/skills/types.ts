/**
 * Local Skill type.
 *
 * pi 1.x changed the SDK's `Skill` (content dropped, baseDir/sourceInfo added,
 * loader-coupled); our skill pipeline (parser → loader → prompt injection)
 * serves full file content to the model, so we own the shape instead of
 * importing it from @earendil-works/pi-agent-core (which no longer exports it
 * at 1.1.0).
 */
export interface Skill {
	name: string;
	description: string;
	/** Full SKILL.md body below the frontmatter — injected into the prompt. */
	content: string;
	filePath: string;
	/** When true the skill is hidden from the prompt and only loadable explicitly. */
	disableModelInvocation?: boolean;
}
