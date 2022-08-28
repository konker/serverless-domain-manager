import Globals from "../globals";
import {getAWSPagedResults, throttledCall} from "../utils";
import DomainConfig = require("../domain-config");
import {Route53} from "aws-sdk";

class Route53Wrapper {
    public route53: Route53;

    constructor(profile?: string, region?: string) {
        let credentials = Globals.serverless.providers.aws.getCredentials();
        credentials.region = Globals.serverless.providers.aws.getRegion();
        credentials.httpOptions = Globals.serverless.providers.aws.sdk.config.httpOptions;

        if (profile) {
            credentials = {
                credentials: new Globals.serverless.providers.aws.sdk.SharedIniFileCredentials({
                    profile
                }),
                region: region || credentials.region,
                httpOptions: credentials.httpOptions
            };
        }
        this.route53 = new Globals.serverless.providers.aws.sdk.Route53(credentials);
    }

    /**
     * Assume the given role in the given region
     * @param roleArn: The ARN of the role to assume
     * @param [region]: The region to use
     */
    public async assumeRole(roleArn: string, region?: string): Promise<void> {
        // get credentials by assuming role
        const result = await Globals.serverless.providers.aws.request('STS', 'assumeRole', {
            RoleArn: roleArn,
            RoleSessionName: 'serverless-domain-manager'
        });
        const assumedCredentialsConfig = {
            credentials: {
                accessKeyId: result.Credentials.AccessKeyId,
                secretAccessKey: result.Credentials.SecretAccessKey,
                sessionToken: result.Credentials.SessionToken,
            },
            region: region ?? this.route53.config.region,
            httpOptions: this.route53.config.httpOptions
        }

        this.route53 = new Globals.serverless.providers.aws.sdk.Route53(assumedCredentialsConfig);
        Globals.logInfo(`Assumed credentials for role: '${roleArn}' in region: '${assumedCredentialsConfig.region}'`);
    }

    /**
     * Change A Alias record through Route53 based on given action
     * @param action: String descriptor of change to be made. Valid actions are ['UPSERT', 'DELETE']
     * @param domain: DomainInfo object containing info about custom domain
     */
    public async changeResourceRecordSet(action: string, domain: DomainConfig): Promise<void> {
        if (domain.createRoute53Record === false) {
            Globals.logInfo(`Skipping ${action === "DELETE" ? "removal" : "creation"} of Route53 record.`);
            return;
        }

        // Set up parameters
        const route53HostedZoneId = await this.getRoute53HostedZoneId(domain);
        const route53Params = domain.route53Params;
        const route53healthCheck = route53Params.healthCheckId ? {HealthCheckId: route53Params.healthCheckId} : {};
        const domainInfo = domain.domainInfo ?? {
            domainName: domain.givenDomainName,
            hostedZoneId: route53HostedZoneId,
        }

        let routingOptions = {}
        if (route53Params.routingPolicy === Globals.routingPolicies.latency) {
            routingOptions = {
                Region: this.route53.config.region,
                SetIdentifier: domain.route53Params.setIdentifier ?? domainInfo.domainName,
                ...route53healthCheck,
            }
        }

        if (route53Params.routingPolicy === Globals.routingPolicies.weighted) {
            routingOptions = {
                Weight: domain.route53Params.weight,
                SetIdentifier: domain.route53Params.setIdentifier ?? domainInfo.domainName,
                ...route53healthCheck,
            }
        }

        const recordsToCreate = domain.createRoute53IPv6Record ? ["A", "AAAA"] : ["A"];
        const changes = recordsToCreate.map((Type) => ({
            Action: action,
            ResourceRecordSet: {
                AliasTarget: {
                    DNSName: domainInfo.domainName,
                    EvaluateTargetHealth: false,
                    HostedZoneId: domainInfo.hostedZoneId,
                },
                Name: domain.givenDomainName,
                Type,
                ...routingOptions,
            },
        }));
        const params = {
            ChangeBatch: {
                Changes: changes,
                Comment: `Record created by "${Globals.pluginName}"`,
            },
            HostedZoneId: route53HostedZoneId,
        };
        // Make API call
        try {
            return await throttledCall(this.route53, "changeResourceRecordSets", params);
        } catch (err) {
            throw new Error(`Failed to ${action} A Alias for '${domain.givenDomainName}':\n${err.message}`);
        }
    }

    /**
     * Gets Route53 HostedZoneId from user or from AWS
     */
    public async getRoute53HostedZoneId(domain: DomainConfig): Promise<string> {
        if (domain.hostedZoneId) {
            Globals.logInfo(`Selected specific hostedZoneId ${domain.hostedZoneId}`);
            return domain.hostedZoneId;
        }

        const filterZone = domain.hostedZonePrivate !== undefined;
        if (filterZone) {
            const zoneTypeString = domain.hostedZonePrivate ? "private" : "public";
            Globals.logInfo(`Filtering to only ${zoneTypeString} zones.`);
        }

        let hostedZones = [];
        try {
            hostedZones = await getAWSPagedResults(
                this.route53,
                "listHostedZones",
                "HostedZones",
                "Marker",
                "NextMarker",
                {}
            );
        } catch (err) {
            throw new Error(`Unable to list hosted zones in Route53.\n${err.message}`);
        }

        const targetHostedZone = hostedZones
            .filter((hostedZone) => {
                return !filterZone || domain.hostedZonePrivate === hostedZone.Config.PrivateZone;
            })
            .filter((hostedZone) => {
                const hostedZoneName = hostedZone.Name.replace(/\.$/, "");
                return domain.givenDomainName.endsWith(hostedZoneName);
            })
            .sort((zone1, zone2) => zone2.Name.length - zone1.Name.length)
            .shift();

        if (targetHostedZone) {
            return targetHostedZone.Id.replace("/hostedzone/", "");
        } else {
            throw new Error(`Could not find hosted zone '${domain.givenDomainName}'`);
        }
    }
}

export = Route53Wrapper;
