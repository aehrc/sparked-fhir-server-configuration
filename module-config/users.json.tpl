{
  "users": [
    {
      "username": "ADMIN",
      "password": "${admin_password}",
      "familyName": "GenericUser",
      "givenName": "Admin",
      "authorities": [
        {
          "permission": "ROLE_SUPERUSER"
        }
      ]
    },
    {
      "username": "DevTester",
      "password": "${devtester_password}",
      "familyName": "GenericUser",
      "givenName": "DevTester",
      "authorities": [
        {
          "permission": "ROLE_FHIR_CLIENT"
        },
        {
          "permission": "FHIR_ALL_READ"
        },
        {
          "permission": "FHIR_WRITE_ALL_OF_TYPE",
          "argument": "StructureDefinition"
        },
        {
          "permission": "FHIR_WRITE_ALL_OF_TYPE",
          "argument": "CodeSystem"
        },
        {
          "permission": "FHIR_WRITE_ALL_OF_TYPE",
          "argument": "ValueSet"
        },
        {
          "permission": "FHIR_WRITE_ALL_OF_TYPE",
          "argument": "ConceptMap"
        },
        {
          "permission": "FHIR_TRANSACTION"
        },
        {
          "permission": "FHIR_CAPABILITIES"
        },
        {
          "permission": "FHIR_MANUAL_VALIDATION"
        },
        {
          "permission": "FHIR_OP_PACKAGE"
        },
        {
          "permission": "FHIR_UPLOAD_EXTERNAL_TERMINOLOGY"
        },
        {
          "permission": "FHIR_ACCESS_PARTITION_NAME",
          "argument": "DEFAULT"
        },
        {
          "permission": "ACCESS_FHIRWEB"
        },
        {
          "permission": "FHIR_MODIFY_SEARCH_PARAMETERS"
        }
      ]
    },
    {
      "username": "placer",
      "password": "<example>",
      "familyName": "placer",
      "givenName": "placer",
      "authorities": [
        {
          "permission": "ROLE_FHIR_CLIENT_SUPERUSER"
        },
        {
          "permission": "ROLE_FHIR_CLIENT"
        },
        {
          "permission": "FHIR_ALL_READ"
        },
        {
          "permission": "FHIR_WRITE_ALL_OF_TYPE",
          "argument": "StructureDefinition"
        },
        {
          "permission": "FHIR_WRITE_ALL_OF_TYPE",
          "argument": "CodeSystem"
        },
        {
          "permission": "FHIR_WRITE_ALL_OF_TYPE",
          "argument": "ValueSet"
        },
        {
          "permission": "FHIR_WRITE_ALL_OF_TYPE",
          "argument": "ConceptMap"
        },
        {
          "permission": "FHIR_TRANSACTION"
        },
        {
          "permission": "FHIR_CAPABILITIES"
        },
        {
          "permission": "FHIR_MANUAL_VALIDATION"
        },
        {
          "permission": "FHIR_OP_PACKAGE"
        },
        {
          "permission": "FHIR_UPLOAD_EXTERNAL_TERMINOLOGY"
        },
        {
          "permission": "FHIR_ACCESS_PARTITION_NAME",
          "argument": "DEFAULT"
        },
        {
          "permission": "ACCESS_FHIRWEB"
        },
        {
          "permission": "FHIR_MODIFY_SEARCH_PARAMETERS"
        }
      ]
    },
    {
      "username": "filler",
      "password": "<example>",
      "familyName": "filler",
      "givenName": "filler",
      "authorities": [
        {
          "permission": "ROLE_FHIR_CLIENT_SUPERUSER"
        },
        {
          "permission": "ROLE_FHIR_CLIENT"
        },
        {
          "permission": "FHIR_ALL_READ"
        },
        {
          "permission": "FHIR_TRANSACTION"
        },
        {
          "permission": "FHIR_CAPABILITIES"
        },
        {
          "permission": "FHIR_MANUAL_VALIDATION"
        },
        {
          "permission": "FHIR_OP_PACKAGE"
        },
        {
          "permission": "FHIR_UPLOAD_EXTERNAL_TERMINOLOGY"
        },
        {
          "permission": "FHIR_ACCESS_PARTITION_NAME",
          "argument": "DEFAULT"
        },
        {
          "permission": "ACCESS_FHIRWEB"
        },
        {
          "permission": "FHIR_MODIFY_SEARCH_PARAMETERS"
        }
      ]
    },
    {
      "username": "ANONYMOUS",
      "familyName": "Anonymous",
      "givenName": "Anonymous",
      "systemUser": true,
      "authorities": [
        {
          "permission": "ROLE_ANONYMOUS"
        },
        {
          "permission": "ROLE_FHIR_CLIENT"
        },
        {
          "permission": "FHIR_OP_PACKAGE"
        },
        {
          "permission": "FHIR_ALL_READ"
        },
        {
          "permission": "FHIR_CAPABILITIES"
        },
        {
          "permission": "FHIR_MANUAL_VALIDATION"
        },
        {
          "permission": "FHIR_ACCESS_PARTITION_NAME",
          "argument": "DEFAULT"
        }
      ]
    }
  ]
}