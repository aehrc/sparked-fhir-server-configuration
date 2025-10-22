Hey there is a new fhir spec

Tempalted email, github form etc...

Service portal? 

Request process and 

Outages - status page

Test data refresh on demand, $expunge

How to engage with capabilities 

1st and 2nd septermber is the event 


stats on usage 

**Release Request Template:**

- IG snapshot specifications (version, environment, timeline)
- Test data requirements (scope, refresh frequency, anonymization needs)
- Server configuration changes (endpoints, security, capacity)
- Approval workflow and stakeholders
- Rollback procedures

**Request Initiation:**

- Content team creates Confluence page with standardized template
- Include: requirements, timeline, business justification, acceptance criteria
- Tag relevant stakeholders (you, Michael W, etc.)

**Processing:**

- You provide status updates directly on the Confluence page
- Use standardized status labels (Received, In Progress, Testing, Complete)
- Include technical notes and any blockers

**Completion & Notification:**

- Final update on Confluence page
- Zulip notification to stakeholders with link to completed work
- Close with lessons learned or follow-up items



ideal request release process:
- public facing
- github issue template
- dropdown/fields formatting
- confluence is not for BAU, for documentation around content/plans/current/static docs

I want to:
- release something (IG) - github template
- execute something defined (load/reload data) - github template/pipeline
- change/add something (config change) - github issue/PR
- current config documentation - confluence? (user focused/oriented)
- EPIC new feature - internal work in JIRA/confluence but kicked off publicly first

Want a succinct single page stripped down important info of what server can do from a users POV, links to more detailed pages for interested

Communications:
- Release info that is relevant to public - this happens on zulip
- Not all discussion/chatter is public - this happens over teams
- slas and notice of updates? document of SLA's, not prod - best effort, 
	- not a reference implementation so should not be depended on
	- server is a reflection of the program as a whole so prefer it to be as brillant and shining as the program
	- Creation of ADR to get approved by decision makers

I am thinkng when the content team request/want something maybe they make a new confluence page since JIRA is not accessible/widely used by team with the requirements/expectations, i post updates to that and once complete I notify relevant people via zulip?
- csiro jira sucks, sparked projects are puma
- needs to be a public way for people to raise comments
- csiro jira can maybe be used internally


create some pipelines for defined things like loading/expunging test data
steps for actual 
- things like $expunging of test data

break out smilecdr app config into seperate repo 
- use github issues tracker for new config changes
- discussion and changes are visible to sparked members
- have a standardised template
- should the public smilecdr repo be in AEHRC org?

all tech decisions need to go via DTR and brett esler

Verification of work by someone to make sure it meets expectations