import type { SVGProps } from 'react';

export type IconName =
  | 'dashboard'
  | 'projects'
  | 'runs'
  | 'records'
  | 'vacancies'
  | 'tenders'
  | 'companies'
  | 'module'
  | 'settings'
  | 'account'
  | 'shield'
  | 'arrow'
  | 'plus'
  | 'menu'
  | 'close'
  | 'search'
  | 'logout';
const paths: Record<IconName, string> = {
  dashboard: 'M3 3h7v7H3z M14 3h7v4h-7z M14 11h7v10h-7z M3 14h7v7H3z',
  projects: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  runs: 'm9 5 11 7-11 7z M4 5v14',
  records: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h5',
  vacancies: 'M8 7V4h8v3 M3 7h18v13H3z M3 12l9 3 9-3 M12 12v4',
  tenders: 'm3 9 9-6 9 6z M5 10v9 M10 10v9 M14 10v9 M19 10v9 M3 21h18',
  companies: 'M4 21V3h11v18 M15 9h5v12 M8 7h3 M8 11h3 M8 15h3 M2 21h20',
  module: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  account: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z m-4 9 3 3 5-6',
  arrow: 'M4 12h16 m-6-6 6 6-6 6',
  plus: 'M12 5v14 M5 12h14',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'm6 6 12 12 M6 18 18 6',
  search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 m-2 5 6 6',
  logout: 'M9 4H4v16h5 M10 12h11 m-4-4 4 4-4 4',
};
export function Icon({ name, className = 'h-5 w-5', ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
