# 02 — Eclipse Che

> **One-line verdict:** Strongest isolation (1 k8s pod/workspace) but **requires
> Kubernetes** and **prefers per-workspace subdomains** — both fight our
> single-VM, no-k8s, path-routing-only constraints. **Poor fit.**

## 1. What it is & status

"A Kubernetes-native IDE and developer collaboration platform" — a multi-tenant,
in-browser cloud development environment (CDE). **Actively developed**: latest
stable **7.118.0 (May 2026)**, frequent point releases. Eclipse Foundation
project with **Red Hat** as dominant contributor; **OpenShift Dev Spaces** is the
commercial downstream (OpenShift-only).

**Editor:** the old **che-theia editor is archived/deprecated** (read-only since
Apr 2023). The default browser IDE is now **che-code** (`che-incubator/che-code`),
an upstream **Code-OSS (VS Code OSS)** integration — so in 2026 Che gives genuine
VS Code-grade editing. JetBrains IDEs also supported.

## 2. Isolation model — fits the need well

Multi-tenant by design; isolation is **stronger than asked for**. Each
**workspace = its own Kubernetes Pod** with its own containers/tools/filesystem;
"workspaces are isolated from one another." Storage is per-user persistent volumes
(one PV per user, mounted via `subPath` per workspace). **Each session natively
gets isolated files** — the one dimension where Che clearly beats code-server.

## 3. THE feasibility question: does Che require Kubernetes? — YES

**Positive confirmation: current Che (7.x) mandates Kubernetes or OpenShift.**
Official docs call it "Kubernetes-native"; workspaces *are* k8s Pods managed by
the **DevWorkspace Operator** (a CRD operator). Install is `chectl`/Helm against
a cluster; prerequisites are "a Kubernetes cluster, an Ingress controller, and a
TLS certificate."

**The Docker-only path is gone** — it existed only in legacy **Che 5/6
(~2016–2018)**, since rearchitected away. No docker-compose install for current
Che. The lightest realistic single-node option is running k8s yourself
(minikube/k3s/kind) — i.e. **installing Kubernetes**, contradicting our "no k8s"
constraint. **No positive confirmation of any supported Docker-only deployment in
7.x was found.**

## 4. Can it deliver the editing workflow?

In principle yes (che-code is real VS Code OSS):

- **Custom `.d.ts` autocomplete + type-check** — works as in VS Code; no
  Che-specific obstacle.
- **esbuild build + integrated terminal** — standard; workspace Pod has full
  terminal + Node per its devfile.
- **Devfile (v2) env definition** — Che's native mechanism; good conceptual fit
  for pinning the Node image + typings + build commands.
- **Debugger to `:9229`** — feasible only if the GraalJS target is reachable from
  inside the workspace Pod. The live game client runs *outside* the cluster, so
  you'd need Pod→host routing. **Possible, unverified, your responsibility to
  wire.**

## 5. Self-hosting footprint + Caddy path routing — LIKELY DEALBREAKER

**(a) Routing/DNS.** Che strongly prefers **per-workspace subdomain routing**
(`workspace.example.com`) — which we explicitly cannot do. Che has a **single-host
/ subpath mode** (built-in Traefik gateway), but the history is full of bugs:
"Devfile endpoints do not work on single-host" (#20593), path-rewrite issues, a
documented push to **expose endpoints on subdomains even in single-host mode**
(#17840). Current DevWorkspace architecture says "both subdomain and subpath
endpoints are always present in any non-trivial DevWorkspace" — i.e. **some
endpoints expect subdomains regardless.** **No positive confirmation that a pure
path-only, no-wildcard-DNS deployment behind an external Caddy works cleanly** —
not asserting it does.

**(b) Footprint.** A full k8s control plane + Che operator + DevWorkspace operator
+ per-workspace Pods on one VM. Substantially heavier than one code-server
container; built for clusters, not a 1-VM appliance.

## 6. Licensing

**EPL-2.0** — permissive, fine for self-hosting/commercial internal use.

## 7. Verdict

- **Best fit:** teams already on Kubernetes/OpenShift wanting strong
  per-workspace Pod isolation + devfile-defined environments.
- **Dealbreakers for us:** (1) **requires Kubernetes** (no Docker-only path) —
  directly conflicts with "no k8s, one VM"; (2) **routing assumes
  subdomains/wildcard DNS**, path-only behind external Caddy is unconfirmed +
  historically buggy; (3) **heavy footprint** vs a single container.

Che solves isolation but pays for it with a k8s + subdomain-ingress architecture
that fights both of our hard constraints. **Poor fit** unless we adopt single-node
k8s and solve path routing experimentally.

**Uncertainty flags:** path-only/no-wildcard routing viability and cross-boundary
`:9229` debugging are both *unverified*; a throwaway PoC would be needed before
committing.

## Sources

- Intro to Eclipse Che — https://eclipse.dev/che/docs/stable/overview/introduction-to-eclipse-che/
- Releases (7.118.0) — https://github.com/eclipse-che/che/releases
- Helm chart 7.118.0 — https://artifacthub.io/packages/helm/eclipse-che/eclipse-che
- DevWorkspace Operator — https://eclipse.dev/che/docs/stable/administration-guide/devworkspace-operator/
- Managing workspaces w/ k8s APIs — https://eclipse.dev/che/docs/stable/end-user-guide/managing-workspaces-with-apis/
- Editor definitions / che-code — https://eclipse.dev/che/docs/stable/administration-guide/configuring-editors-definitions/ , https://github.com/che-incubator/che-code
- Sunset che-theia (#21771) — https://github.com/eclipse-che/che/issues/21771
- che-theia archived — https://github.com/eclipse-che/che-theia
- OpenShift Dev Spaces — https://docs.redhat.com/en/documentation/red_hat_openshift_dev_spaces/3.2/html/release_notes_and_known_issues/about-devspaces_devspaces
- Single-host strategy (#16702) — https://github.com/eclipse/che/issues/16702
- Subdomains in single-host (#17840) — https://github.com/eclipse-che/che/issues/17840
- Endpoints fail on single-host (#20593) — https://github.com/eclipse-che/che/issues/20593
- EKS prerequisites — https://eclipse.dev/che/docs/stable/administration-guide/installing-che-on-amazon-elastic-kubernetes-service/
- Legacy Che 5.0 (Docker, historical) — https://projects.eclipse.org/projects/ecd.che/releases/5.0/review
