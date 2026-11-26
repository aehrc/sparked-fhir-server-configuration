# What the sdh-deps module would pass to Helm for the Smile CDR release, now that
# the Argo CD Application smilecdr deploys it (helm_deploy = false): the module's
# full value list, in merge order, and the --set overrides. Read by
#
#   python3 scripts/smile_argo_check.py values --argo-repo <sparked-argo> \
#     --terraform-output <(terraform output -json smilecdr_helm_values)
#
# which fails when the module would set anything differently from the
# Application's value files (aehrc/sparked-argo apps/smilecdr/values-account.yaml
# and the files under module-config/ and deploy/). Run it after every apply here
# and before bumping the module or the chart.
#
# ARNs and names only: the module mounts every secret through the Secrets Store
# CSI driver and puts no secret value in its Helm values. Sensitive anyway, so a
# plan does not print the mapped files and ARNs into its output.
output "smilecdr_helm_values" {
  description = "The sdh-deps module's Helm values for Smile CDR (values list and --set overrides), for scripts/smile_argo_check.py."
  sensitive   = true
  value = {
    values = module.smile_cdr_dependencies.helm_chart_values
    # The module merges its own overrides under ours before calling Helm
    # (sdh-deps v9.0.2 locals.tf, helm_chart_values_set_overrides):
    # replicaCount and specs.hostname = its public_fqdn, which is "" here
    # (manage_ingress = false). It does not export that merged map, so it is
    # rebuilt here; ours win, as they do in the module.
    set = merge(
      {
        "replicaCount"   = 1
        "specs.hostname" = module.smile_cdr_dependencies.url
      },
      local.helm_chart_values_set_overrides
    )
  }
}
