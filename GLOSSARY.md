# pi-secret

Hands secrets to an omp agent so it can use them without their values ever entering the model context.

## Language

**Secret**:
A named value supplied by the user that the model must never see.
_Avoid_: credential, password (as the generic term)

**Tier**:
Where a secret is kept: ephemeral or persistent. A secret has exactly one tier.
_Avoid_: storage type, mode

**Ephemeral secret**:
A secret held only in the memory of the running omp process and gone when the main session closes.
_Avoid_: ethereal, temporary, session secret

**Persistent secret**:
A secret kept encrypted in the vault until explicitly deleted.
_Avoid_: saved secret, stored secret

**Project**:
The git repository root of the working directory, or the directory itself outside git; every secret belongs to one project.
_Avoid_: workspace, scope

**Vault**:
The encrypted store holding the persistent secrets of all projects.
_Avoid_: keyring, store file

**Vault key**:
The key that encrypts the vault: derived from Windows Hello on Windows, kept in the OS keyring elsewhere.

**Unlock**:
Obtaining the vault key, at most once per omp process.

**Binding**:
Attaching a secret to a single command, either as an environment variable or as a short-lived file.
_Avoid_: injection, mount

**Redaction**:
Replacing a secret's value with `[secret:<name>]` in anything the model receives.
_Avoid_: masking (reserved for the user-facing bullets)

**Reveal**:
Showing a secret's value to the user, never to the model.

**Import**:
Creating a secret from an automatic source (command output, file, HTTP response, environment variable) without the value passing through the model.
