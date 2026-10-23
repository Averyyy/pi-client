export type IconName =
	| "folder"
	| "chevron"
	| "arrow"
	| "menu"
	| "close"
	| "logout"
	| "home"
	| "terminal"
	| "spark"
	| "lock";

const paths: Record<IconName, string> = {
	folder:
		"M3 7V5.5A1.5 1.5 0 0 1 4.5 4H9l2 2h8.5A1.5 1.5 0 0 1 21 7.5V9M3 7h17.1a1 1 0 0 1 1 1.2l-1.7 9a1 1 0 0 1-1 .8H4a1 1 0 0 1-1-1V7Z",
	chevron: "m9 5 7 7-7 7",
	arrow: "M19 12H5m7-7-7 7 7 7",
	menu: "M4 6h16M4 12h16M4 18h16",
	close: "m6 6 12 12M6 18 18 6",
	logout: "M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4m7-4 4-4-4-4m-6 4h10",
	home: "m3 10 9-7 9 7v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9Zm6 10v-7h6v7",
	terminal: "m5 7 5 5-5 5m8 0h6",
	spark: "m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z",
	lock: "M7 10V7a5 5 0 0 1 10 0v3M6 10h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm6 4v3",
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
		>
			<path d={paths[name]} />
		</svg>
	);
}
