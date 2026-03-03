SmileCDR v6 Bug Reports
=======================
On a clean install with a clean node and same config files as v4 and v5 the following bugs were found:

DELETE {{baseURLSmile}}/hl7au/package/write/hl7.fhir.uv.ips/2.0.0 returns 500 error 
`HAPI-2223: The name must not be null or blank`

with logs
00:38:32.004 [fhir_endpoint.fhirEndpointServer-126] DEBUG M:fhir_endpoint R:EwUjpkiKrLC3g3Sn T: S: J: C: ca.cdr.log.http_troubleshooting - [hl7au fhir_endpoint] 10.0.50.192 [HTTP/1.1 GET /hl7au/fhir/endpoint-health] -- 200 30 -- 3ms
00:38:39.679 [package_registry.packageRegistryJettyServer-132] DEBUG M:package_registry R:dc0f0537744ca99fdf0841e68996957e T:615593ea011d8676ee3ddbf23a3e5035 S:f266579634a800e6 J: C: ca.cdr.log.http_troubleshooting - Starting server DELETE request /hl7au/package/write/hl7.fhir.uv.ips/2.0.0
00:38:39.679 [package_registry.packageRegistryJettyServer-132] DEBUG M:package_registry R:dc0f0537744ca99fdf0841e68996957e T:615593ea011d8676ee3ddbf23a3e5035 S:f266579634a800e6 J: C: ca.cdr.log.http_troubleshooting - Starting server DELETE request /hl7au/package/write/hl7.fhir.uv.ips/2.0.0
00:38:39.681 [package_registry.packageRegistryJettyServer-132] DEBUG M:package_registry R:dc0f0537744ca99fdf0841e68996957e T:615593ea011d8676ee3ddbf23a3e5035 S:f266579634a800e6 J: C: ca.cdr.log.security_troubleshooting - Local inbound security login succeeded with principal: [52/ADMIN]
00:38:39.681 [package_registry.packageRegistryJettyServer-132] DEBUG M:package_registry R:dc0f0537744ca99fdf0841e68996957e T:615593ea011d8676ee3ddbf23a3e5035 S:f266579634a800e6 J: C: ca.cdr.log.security_troubleshooting - Local inbound security login succeeded with principal: [52/ADMIN]
00:38:39.682 [package_registry.packageRegistryJettyServer-132] DEBUG M:package_registry R:dc0f0537744ca99fdf0841e68996957e T:615593ea011d8676ee3ddbf23a3e5035 S:f266579634a800e6 J: C: c.u.f.log.partition_troubleshooting - Partitioning: action=generic resource type=null with request tenant ID=null routed to RequestPartitionId=RequestPartitionId[ids=[null],names=[null]]
00:38:39.682 [package_registry.packageRegistryJettyServer-132] DEBUG M:package_registry R:dc0f0537744ca99fdf0841e68996957e T:615593ea011d8676ee3ddbf23a3e5035 S:f266579634a800e6 J: C: c.u.f.log.partition_troubleshooting - Partitioning: action=generic resource type=null with request tenant ID=null routed to RequestPartitionId=RequestPartitionId[ids=[null],names=[null]]
00:38:39.687 [package_registry.packageRegistryJettyServer-132] INFO  M:package_registry R:dc0f0537744ca99fdf0841e68996957e T:615593ea011d8676ee3ddbf23a3e5035 S:f266579634a800e6 J: C: c.u.f.jpa.packages.JpaPackageCache - Deleting package hl7.fhir.uv.ips#2.0.0
00:38:39.697 [package_registry.packageRegistryJettyServer-132] INFO  M:package_registry R:dc0f0537744ca99fdf0841e68996957e T:615593ea011d8676ee3ddbf23a3e5035 S:f266579634a800e6 J: C: c.u.f.jpa.packages.JpaPackageCache - Deleting package +hl7.fhir.uv.ips#2.0.0resource: null
00:38:39.716 [package_registry.packageRegistryJettyServer-132] WARN  M:package_registry R:dc0f0537744ca99fdf0841e68996957e T:615593ea011d8676ee3ddbf23a3e5035 S:f266579634a800e6 J: C: c.c.a.w.BaseControllerWithDefaultExceptionHandlers - Exception caught during rest processing:

or DELETE {{baseURLSmile}}/ereq/package/write/hl7.fhir.au.base/6.0.0-ballot

logs from smilecdr

00:28:39.409 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: ca.cdr.log.http_troubleshooting - Starting server DELETE request /ereq/package/write/hl7.fhir.au.base/6.0.0-ballot
00:28:39.409 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: ca.cdr.log.http_troubleshooting - Starting server DELETE request /ereq/package/write/hl7.fhir.au.base/6.0.0-ballot
00:28:39.689 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: ca.cdr.log.security_troubleshooting - No "onAuthenticateSuccess" script.
00:28:39.689 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: ca.cdr.log.security_troubleshooting - No "onAuthenticateSuccess" script.
00:28:39.690 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: ca.cdr.log.security_troubleshooting - Local inbound security login succeeded with principal: [1/ADMIN]
00:28:39.690 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: ca.cdr.log.security_troubleshooting - Local inbound security login succeeded with principal: [1/ADMIN]
00:28:39.691 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: c.u.f.log.partition_troubleshooting - Partitioning: action=generic resource type=null with request tenant ID=null routed to RequestPartitionId=RequestPartitionId[ids=[null],names=[null]]
00:28:39.691 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: c.u.f.log.partition_troubleshooting - Partitioning: action=generic resource type=null with request tenant ID=null routed to RequestPartitionId=RequestPartitionId[ids=[null],names=[null]]
00:28:39.720 [package_registry.packageRegistryJettyServer-133] INFO  M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: c.u.f.jpa.packages.JpaPackageCache - Deleting package hl7.fhir.au.base#6.0.0-ballot
00:28:39.739 [package_registry.packageRegistryJettyServer-133] INFO  M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: c.u.f.jpa.packages.JpaPackageCache - Deleting package +hl7.fhir.au.base#6.0.0-ballotresource: http://hl7.org.au/fhir/StructureDefinition/address-identifier
00:28:39.744 [package_registry.packageRegistryJettyServer-133] WARN  M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: c.c.a.w.BaseControllerWithDefaultExceptionHandlers - Exception caught during rest processing: 
ca.uhn.fhir.rest.server.exceptions.InternalErrorException: HAPI-2223: The name must not be null or blank
...
00:28:39.745 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: ca.cdr.log.http_troubleshooting - Finished server DELETE request /ereq/package/write/hl7.fhir.au.base/6.0.0-ballot in 336ms
00:28:39.745 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T: S: J: C: ca.cdr.log.http_troubleshooting - [ereq package_registry] <redacted> [HTTP/1.1 DELETE /ereq/package/write/hl7.fhir.au.base/6.0.0-ballot] -- 500 45 -- 336ms
00:28:39.745 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T:8ee507917087a9557ca6cffcf5564c11 S:a151cf79621b4bd6 J: C: ca.cdr.log.http_troubleshooting - Finished server DELETE request /ereq/package/write/hl7.fhir.au.base/6.0.0-ballot in 336ms
00:28:39.745 [package_registry.packageRegistryJettyServer-133] DEBUG M:package_registry R:a518b3c8cd97ae3a473dfea4337d2a89 T: S: J: C: ca.cdr.log.http_troubleshooting - [ereq package_registry] <redacted> [HTTP/1.1 DELETE /ereq/package/write/hl7.fhir.au.base/6.0.0-ballot] -- 500 45 -- 336ms


Downgrading from v6.1 to v5.1 and running the same DELETE commands works as expected. Which means that the issue is introduced in v6 and the package is not corrupt/db issues as otherwise v5 wouldnt have been able to delete it either.