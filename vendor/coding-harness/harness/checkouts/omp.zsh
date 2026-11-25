function omp {
	emulate -L zsh
	local launcher="${OMP_HARNESS_DIR:-$HOME/.omp/agent/harness}/checkouts/launch.ts" out dir why word
	local -a args
	local -i here=0 words=0
	for word in "$@"; do
		if (( ! words )) && [[ $word == --here ]]; then
			here=1
			continue
		fi
		[[ $word == -- ]] && words=1
		args+=("$word")
	done
	if (( here )) || [[ ! -t 0 || ! -t 1 ]] || [[ -n ${OMP_CHECKOUT_OFF-} ]]; then
		command omp "${args[@]}"
		return
	fi
	if (( ! $+commands[bun] )); then
		why="bun is not installed"
	elif [[ ! -f $launcher ]]; then
		why="$launcher is missing"
	else
		out=$(perl -e 'alarm shift; exec @ARGV' 20 bun "$launcher" $$ "$PWD" -- "${args[@]}")
		case $? in
			0) ;;
			*) out=; why="the launcher failed or ran past 20 s" ;;
		esac
	fi
	case $out in
		here)
			command omp "${args[@]}"
			return
			;;
		run$'\t'/*)
			dir=${out#run$'\t'}
			if [[ -d $dir ]] && ( builtin cd -- "$dir" ) 2>/dev/null; then
				( builtin cd -- "$dir" && command omp "${args[@]}" )
				return
			fi
			why="$dir is not usable"
			;;
		*)
			: ${why:=the launcher printed no usable answer}
			;;
	esac
	print -u2 -r -- "omp: main checkout skipped ($why); running in $PWD"
	command omp "${args[@]}"
}
