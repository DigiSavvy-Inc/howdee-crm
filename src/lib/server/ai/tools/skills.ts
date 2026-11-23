// load_skill (#302): returns an enabled skill's full instructions. The system prompt lists
// on-demand skills by name + description; the model calls this when one is relevant.
// Skills are operator-authored and trusted (see system.ts).

import { skillTitle } from '$lib/ai-skills';
import { enabledSkillByName, enabledSkillNames } from '../skills';
import { ToolInputError, strArg, type Tool } from './types';

export const skillTools: Tool[] = [
	{
		name: 'load_skill',
		tier: 'read',
		description:
			'Load the full instructions of one of your skills (listed under "Your skills" in the system prompt) by name. Call it before answering when a listed on-demand skill fits the question, then follow its instructions.',
		input_schema: {
			type: 'object',
			properties: { name: { type: 'string', description: 'The skill name, e.g. campaign-strategy.' } },
			required: ['name']
		},
		summarize: (input) => skillTitle(strArg(input, 'name', 64)),
		handler: async (ctx, input) => {
			const name = strArg(input, 'name', 64);
			if (!name) throw new ToolInputError('"name" is required.');
			const skill = await enabledSkillByName(ctx.db, name);
			if (!skill) {
				const names = await enabledSkillNames(ctx.db);
				throw new ToolInputError(
					`No enabled skill named "${name}".${names.length ? ` Available: ${names.join(', ')}.` : ' No skills are enabled.'}`
				);
			}
			return { name: skill.name, description: skill.description, mode: skill.mode, instructions: skill.body };
		}
	}
];
