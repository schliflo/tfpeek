# tfpeek

Read-only web UI for Terraform state kept in GCS: current state, locks, history and deploy runs.
One container, no database, no build step.

Filter with `/`, link straight to a resource (`#address`), light and dark theme. The overview refreshes itself.

- **Overview:** every environment with lock, serial, Terraform version, resource count, last write, last run.
- **Environment:** resources by module and type, outputs, lock detail.
- **History:** state versions with a resource diff and the run that wrote each one.

## Run

```bash
gcloud auth application-default login
docker build -t tfpeek .
docker run --rm -p 8080:8080 \
  -e STATE_BUCKETS=my-tfstate \
  -e GOOGLE_APPLICATION_CREDENTIALS=/adc.json \
  -v ~/.config/gcloud/application_default_credentials.json:/adc.json:ro \
  tfpeek
```

Without Docker: `npm ci && STATE_BUCKETS=my-tfstate npm start` (Node 26).

| Env | |
|---|---|
| `STATE_BUCKETS` | Comma-separated state buckets. Required. |
| `RUNS_BUCKET` | Bucket holding run records. Default: the state bucket. |
| `PORT` | Default `8080`. |
| `TZ` | Timezone for displayed times. Default UTC. |
| `SENTRY_DSN` | Optional. Errors are reported there (message and stack, never state content). |

## Bucket layout

Backend `prefix = "<project>/<branch>"`, object versioning on.

| Object | |
|---|---|
| `<prefix>/<workspace>.tfstate` | State. `default.tfstate` unless you use workspaces. Each write is a new generation. |
| `<prefix>/<workspace>.tflock` | Exists only while locked. Lock info JSON. |
| `runs/<prefix>/<UTC timestamp>-<run id>.json` | Run records, written by CI (below). Non-default workspace: `runs/<prefix>/<workspace>/`. |

The first path segment is shown as the project, the rest as the branch.
History shows the newest 30 state versions; keep noncurrent versions with a lifecycle rule of your choice.

## Run records

Terraform does not record who ran what, so the deploy job writes one small JSON object per run:

```yaml
- id: before
  run: |
    echo "started=$(date -u +%FT%TZ)" >> "$GITHUB_OUTPUT"
    echo "serial=$(terraform state pull | jq -s '.[0].serial // null')" >> "$GITHUB_OUTPUT"

# ... terraform plan / apply ...

- name: Run record
  if: always()
  env:
    DEST: gs://my-tfstate/runs/my-project/${{ github.ref_name }}
    OUTCOME: ${{ job.status }}
    STARTED: ${{ steps.before.outputs.started }}
    SERIAL_BEFORE: ${{ steps.before.outputs.serial || 'null' }}
  run: |
    serial_after=$(terraform state pull 2>/dev/null | jq -s '.[0].serial // null') || serial_after=null
    jq -n --argjson before "$SERIAL_BEFORE" --argjson after "$serial_after" '{
      run_url: "\(env.GITHUB_SERVER_URL)/\(env.GITHUB_REPOSITORY)/actions/runs/\(env.GITHUB_RUN_ID)/attempts/\(env.GITHUB_RUN_ATTEMPT)",
      repo: env.GITHUB_REPOSITORY, branch: env.GITHUB_REF_NAME, commit: env.GITHUB_SHA, actor: env.GITHUB_ACTOR,
      outcome: env.OUTCOME, started_at: env.STARTED, finished_at: (now | todate),
      serial_before: $before, serial_after: $after
    }' > run.json
    gcloud storage cp run.json "$DEST/$(date -u +%Y%m%dT%H%M%SZ)-$GITHUB_RUN_ID.json"
```

A run is linked to every state version with a serial in `(serial_before, serial_after]`.
Runs that wrote no state are listed below the history.

## Secrets

State holds secrets in plain text. tfpeek masks them before anything is rendered or cached:

- every path in an instance's `sensitive_attributes`, and every output marked `sensitive`,
- `random_password` `result` and `bcrypt_hash`,
- any attribute or output whose name matches `secret|password|private_key|token|credential|api_key`,
- `value` next to a `name` that matches (container env vars).

A secret hardcoded under an innocent attribute name is **not** caught. Mark it `sensitive` in Terraform.
Everyone who can open tfpeek sees all remaining state, so put it behind an identity-aware proxy.

## Deploy (Cloud Run)

tfpeek has no login. Run it behind Cloudflare Access, IAP or similar, and block direct access.

```bash
gcloud iam service-accounts create tfpeek
gcloud storage buckets add-iam-policy-binding gs://my-tfstate \
  --member serviceAccount:tfpeek@$PROJECT.iam.gserviceaccount.com --role roles/storage.objectViewer
gcloud run deploy tfpeek --source . --region europe-west3 \
  --service-account tfpeek@$PROJECT.iam.gserviceaccount.com \
  --set-env-vars STATE_BUCKETS=my-tfstate \
  --ingress internal-and-cloud-load-balancing --allow-unauthenticated
```

`objectViewer` is all it needs; it never writes. With that ingress setting the service is reachable only
through a load balancer, which is where the proxy goes.

## Develop

```bash
npm test
```

Try it without a real bucket using [fake-gcs-server](https://github.com/fsouza/fake-gcs-server):
start it with `-scheme http -backend memory` and set `STORAGE_EMULATOR_HOST=http://localhost:4443/storage/v1`.

## License

[MIT](LICENSE)
