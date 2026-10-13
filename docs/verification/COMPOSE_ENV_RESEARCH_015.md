# Compose environment research — independent source verification

Docker's current primary documentation confirms `COMPOSE_ENV_FILES` specifies the environment files used when the CLI does not receive `--env-file`. Without either, the default is the project `.env`. Therefore the proposed exported shell variable or explicit `--env-file .env.production` supplies interpolation; loading that file only as a service `env_file` is a different operation and does not supply the proxy's Compose substitution.

Sources inspected:

- https://docs.docker.com/compose/how-tos/environment-variables/envvars/#compose_env_files
- https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation
- https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/
- https://github.com/docker/compose/pull/11061 (feature merged October 5, 2023; comments distinguish exported shell use from early `.env` discovery behavior).

Support was subsequently verified in the official v2.23.0 source: `ComposeEnvFiles` defines the setting and `setEnvWithDotEnv` reads it from `os.Getenv`, splitting the selected files when the CLI flag was not supplied. The inspected v2.22.0 file lacks that setting. This confirms shell-exported support in v2.23.0; it does not independently audit every earlier patch release or later `.env` discovery fixes. The implementation author's recollection of v2.24+ is not the introduction evidence; Docker's v2.24 note on service `env_file.required` is a separate feature.

- https://raw.githubusercontent.com/docker/compose/v2.23.0/cmd/compose/compose.go
- https://raw.githubusercontent.com/docker/compose/v2.22.0/cmd/compose/compose.go

## Native Perplexity consultation

A public, research-only question was sent through the native Perplexity app. Its first answer incorrectly claimed introduction in v2.32.3 and included a release citation whose actual target was `docs.docker.top`, an unofficial mirror. Root did not accept that claim or open that mirror; it challenged the contradiction with official PR11061. Perplexity corrected its answer to v2.23.0 for shell-exported support and distinguished uncertain `.env`-declared discovery behavior. Root separately checked the official tagged source above. Perplexity's Caddy empty-address statement is reasoning, not an executed validation result.

This verifies documentation semantics, not this application's deployment. No Docker/Compose process was executed and no private configuration file was read. Empty-domain Caddy startup behavior and the target host's supported Compose version remain pending runtime checks. The frozen build015 source remains unchanged by this research document.
