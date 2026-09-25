import { Link } from 'react-router-dom';
import type { WorkspaceModule } from '@discovery-platform/client';
import { Card, CardContent } from './card';
import { Icon } from './icon';
import { modulePresentation, moduleUrl } from '../../lib/module-presentation';
export function ModuleCard({ module, projectCount }: { module: WorkspaceModule; projectCount: number }) {
  const { icon, description } = modulePresentation(module.module_id);
  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex h-full flex-col">
        <div className="mb-4 flex items-center justify-between">
          <span className="rounded-xl bg-brand-50 p-3 text-brand-600">
            <Icon name={icon} />
          </span>
          <span className="text-xs text-slate-500">
            {projectCount} {projectCount === 1 ? 'project' : 'projecten'}
          </span>
        </div>
        <h3 className="font-semibold text-slate-900">{module.module_name}</h3>
        <p className="mb-5 mt-2 flex-1 text-sm leading-6 text-slate-500">{description}</p>
        <Link
          to={moduleUrl(module.module_id)}
          className="inline-flex items-center justify-between border-t border-slate-100 pt-4 text-sm font-medium text-brand-700 hover:text-brand-900"
        >
          Open {module.module_name}
          <Icon name="arrow" className="h-4 w-4" />
        </Link>
      </CardContent>
    </Card>
  );
}
