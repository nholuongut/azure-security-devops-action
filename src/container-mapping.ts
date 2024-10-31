import { IMicrosoftSecurityDevOps } from "./msdo-interface";
import * as https from "https";
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as os from 'os';

const sendReportRetryCount: number = 1;
const GetScanContextURL: string = "https://dfdinfra-afdendpoint-prod-d5fqbucbg7fue0cf.z01.azurefd.net/github/v1/auth-push/GetScanContext?context=authOnly";
const ContainerMappingURL: string = "https://dfdinfra-afdendpoint-prod-d5fqbucbg7fue0cf.z01.azurefd.net/github/v1/container-mappings";

/**
 * Represents the tasks for container mapping that are used to fetch Docker images pushed in a job run.
 */
export class ContainerMapping implements IMicrosoftSecurityDevOps {
    readonly succeedOnError: boolean;

    constructor() {
        this.succeedOnError = true;
    }

    /**
     * Container mapping pre-job commands wrapped in exception handling.
     */
    public runPreJob() {
        try {
            core.info("::group::Microsoft Defender for DevOps container mapping pre-job - https://go.microsoft.com/fwlink/?linkid=2231419");
            this._runPreJob();
        }
        catch (error) {
            // Log the error
            core.info("Error in Container Mapping pre-job: " + error);
        }
        finally {
            // End the collapsible section
            core.info("::endgroup::");
        }
    }


    /*
    * Set the start time of the job run.
    */
    private _runPreJob() {
        const startTime = new Date().toISOString();
        core.saveState('PreJobStartTime', startTime);
        core.info(`PreJobStartTime: ${startTime}`);
    }

    /**
     * Placeholder / interface satisfier for main operations
     */
    public async runMain() {
        // No commands
    }

    /**
     * Container mapping post-job commands wrapped in exception handling.
     */
    public async runPostJob() {
        try {
            core.info("::group::Microsoft Defender for DevOps container mapping post-job - https://go.microsoft.com/fwlink/?linkid=2231419");
            await this._runPostJob();
        } catch (error) {
            // Log the error
            core.info("Error in Container Mapping post-job: " + error);
        } finally {
            // End the collapsible section
            core.info("::endgroup::");
        }
    }

    /*
    * Using the start time, fetch the docker events and docker images in this job run and log the encoded output
    * Send the report to Defender for DevOps
    */
    private async _runPostJob() {
        let startTime = core.getState('PreJobStartTime');
        if (startTime.length <= 0) {
            startTime = new Date(new Date().getTime() - 10000).toISOString();
            core.debug(`PreJobStartTime not defined, using now-10secs`);
        }
        core.info(`PreJobStartTime: ${startTime}`);

        let reportData = {
            dockerVersion: "",
            dockerEvents: [],
            dockerImages: []
        };
       
        let bearerToken: string | void = await core.getIDToken()
            .then((token) => { return token; })
            .catch((error) => {
                throw new Error("Unable to get token: " + error);
            });

        if (!bearerToken) {
            throw new Error("Empty OIDC token received");
        }

        // Don't run the container mapping workload if this caller isn't an active customer.
        var callerIsOnboarded: boolean = await this.checkCallerIsCustomer(bearerToken, sendReportRetryCount);
        if (!callerIsOnboarded) {
            core.info("Client is not onboarded to Defender for DevOps. Skipping container mapping workload.")
            return;
        }
        core.info("Client is onboarded for container mapping.");

        // Initialize the commands 
        let dockerVersionOutput = await exec.getExecOutput('docker --version');
        if (dockerVersionOutput.exitCode != 0) {
            core.info(`Unable to get docker version: ${dockerVersionOutput}`);
            core.info(`Skipping container mapping since docker not found/available.`);
            return;
        }
        reportData.dockerVersion = dockerVersionOutput.stdout.trim();

        await this.execCommand(`docker events --since ${startTime} --until ${new Date().toISOString()} --filter event=push --filter type=image --format ID={{.ID}}`, reportData.dockerEvents)
        .catch((error) => {
            throw new Error("Unable to get docker events: " + error);
        });

        await this.execCommand(`docker images --format CreatedAt={{.CreatedAt}}::Repo={{.Repository}}::Tag={{.Tag}}::Digest={{.Digest}}`, reportData.dockerImages)
        .catch((error) => {
            throw new Error("Unable to get docker images: " + error);
        });

        core.debug("Finished data collection, starting API calls.");

        var reportSent: boolean = await this.sendReport(JSON.stringify(reportData), bearerToken, sendReportRetryCount);
        if (!reportSent) {
            throw new Error("Unable to send report to backend service");
        };
        core.info("Container mapping data sent successfully.");
    }

    /**
     * Execute command and setup the listener to capture the output
     * @param command Command to execute
     * @param listener Listener to capture the output
     * @returns a Promise
     */
    private async execCommand(command: string, listener: string[]): Promise<void> {
        return exec.getExecOutput(command)
        .then((result) => {
            if(result.exitCode != 0) {
                return Promise.reject(`Command execution failed: ${result}`);
            }
            result.stdout.trim().split(os.EOL).forEach(element => {
                if(element.length > 0) {
                    listener.push(element);
                }
            });
        });
    }

    /**
     * Sends a report to Defender for DevOps and retries on the specified count
     * @param data the data to send
     * @param retryCount the number of time to retry
     * @param bearerToken the GitHub-generated OIDC token
     * @returns a boolean Promise to indicate if the report was sent successfully or not
     */
    private async sendReport(data: string, bearerToken: string, retryCount: number = 0): Promise<boolean> {
        core.debug(`attempting to send report: ${data}`);
        return await this._sendReport(data, bearerToken)
            .then(() => {
                return true;
            })
            .catch(async (error) => {
                if (retryCount == 0) {
                    return false;
                } else {
                    core.info(`Retrying API call due to error: ${error}.\nRetry count: ${retryCount}`);
                    retryCount--;
                    return await this.sendReport(data, bearerToken, retryCount);
                }
            });
    }

    /**
     * Sends a report to Defender for DevOps
     * @param data the data to send
     * @returns a Promise
     */
    private async _sendReport(data: string, bearerToken: string): Promise<void> {
        return new Promise(async (resolve, reject) => {
            let apiTime = new Date().getMilliseconds();
            let options = {
                method: 'POST',
                timeout: 2500,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + bearerToken,
                    'Content-Length': data.length
                }
            };
            core.debug(`${options['method'].toUpperCase()} ${ContainerMappingURL}`);

            const req = https.request(ContainerMappingURL, options, (res) => {
                let resData = '';
                res.on('data', (chunk) => {
                    resData += chunk.toString();
                });

                res.on('end', () => {
                    core.debug('API calls finished. Time taken: ' + (new Date().getMilliseconds() - apiTime) + "ms");
                    core.debug(`Status code: ${res.statusCode} ${res.statusMessage}`);
                    core.debug('Response headers: ' + JSON.stringify(res.headers));
                    if (resData.length > 0) {
                        core.debug('Response: ' + resData);
                    }
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return reject(`Received Failed Status code when calling url: ${res.statusCode} ${resData}`);
                    }
                    resolve();
                });
            });

            req.on('error', (error) => {
                reject(new Error(`Error calling url: ${error}`));
            });

            req.write(data);
            req.end();
        });
    }

    /**
     * Queries Defender for DevOps to determine if the caller is onboarded for container mapping.
     * @param retryCount the number of time to retry
     * @param bearerToken the GitHub-generated OIDC token
     * @returns a boolean Promise to indicate if the report was sent successfully or not
     */
    private async checkCallerIsCustomer(bearerToken: string, retryCount: number = 0): Promise<boolean> {
        return await this._checkCallerIsCustomer(bearerToken)
        .then(async (statusCode) => {
            if (statusCode == 200) { // Status 'OK' means the caller is an onboarded customer.
                return true;
            } else if (statusCode == 403) { // Status 'Forbidden' means caller is not a customer.
                return false;
            } else {
                core.debug(`Unexpected status code: ${statusCode}`);
                return await this.retryCall(bearerToken, retryCount);
            }
        })
        .catch(async (error) => {
            core.info(`Unexpected error: ${error}.`);
            return await this.retryCall(bearerToken, retryCount);
        });
    }

    private async retryCall(bearerToken: string, retryCount: number): Promise<boolean> {
        if (retryCount == 0) {
            core.info(`All retries failed.`);
            return false;
        } else {
            core.info(`Retrying checkCallerIsCustomer.\nRetry count: ${retryCount}`);
            retryCount--;
            return await this.checkCallerIsCustomer(bearerToken, retryCount);
        }
    }

    private async _checkCallerIsCustomer(bearerToken: string): Promise<number> {
        return new Promise(async (resolve, reject) => {
            let options = {
                method: 'GET',
                timeout: 2500,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + bearerToken,
                }
            };
            core.debug(`${options['method'].toUpperCase()} ${GetScanContextURL}`);

            const req = https.request(GetScanContextURL, options, (res) => {

                res.on('end', () => {
                    resolve(res.statusCode);
                });
                res.on('data', function(d) {
                });
            });

            req.on('error', (error) => {
                reject(new Error(`Error calling url: ${error}`));
            });

            req.end();
        });
    }

}