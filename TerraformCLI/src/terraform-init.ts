import tasks = require("azure-pipelines-task-lib/task");
import { TerraformCommand, TerraformInterfaces, ILogger } from "./terraform";
import { IHandleCommandString } from "./command-handler";
import { injectable, inject } from "inversify";
import { CommandPipeline } from "./command-pipeline";
import { AzLogin } from "./az-login";
import { AzAccountSet } from "./az-account-set";
import { AzGroupCreate } from "./az-group-create";
import { AzStorageAccountCreate } from "./az-storage-account-create";
import { AzStorageContainerCreate } from "./az-storage-container-create";
import { MediatorInterfaces, IMediator } from "./mediator";
import { TerraformRunner, TerraformCommandDecorator, TerraformCommandBuilder, TerraformCommandContext } from "./terraform-runner";

export enum BackendTypes{
    local = "local",
    azurerm = "azurerm"
}

export interface AzureBackendConfig {
    storage_account_name    : string,
    container_name          : string,
    key                     : string,
    resource_group_name     : string,
    arm_subscription_id     : string,
    arm_tenant_id           : string,
    arm_client_id           : string,
    arm_client_secret       : string    
}

export class TerraformInit extends TerraformCommand{
    readonly backendType: BackendTypes | undefined;

    constructor(
        name: string, 
        workingDirectory: string,
        backendType: string,
        options?: string | undefined) {
        super(name, workingDirectory, options);
        if(backendType){
            this.backendType = BackendTypes[<keyof typeof BackendTypes> backendType];                
        }
    }
}

declare module "./terraform-runner" {
    interface TerraformRunner{
        withAzureRmBackend(this: TerraformRunner, mediator: IMediator, backendType?: BackendTypes | undefined): TerraformRunner;
    }
}

export class TerraformWithAzureRmBackend extends TerraformCommandDecorator{    
    private readonly backendType?: BackendTypes | undefined
    private readonly mediator: IMediator;
    constructor(builder: TerraformCommandBuilder, mediator: IMediator, backendType?: BackendTypes | undefined) {
        super(builder);
        this.backendType = backendType;
        this.mediator = mediator;
    }
    async onRun(context: TerraformCommandContext): Promise<void> {        
        if(context.command.name !== 'init')
            throw "azurerM backend should only be setup for 'init' command.";
            
        if(this.backendType && this.backendType == BackendTypes.azurerm){
            let backendServiceName = tasks.getInput("backendServiceArm", true);
            let scheme = tasks.getEndpointAuthorizationScheme(backendServiceName, true);
            if(scheme != "ServicePrincipal"){
                throw "Terraform backend initialization for AzureRM only support service principal authorization";
            }

            let backendConfig: AzureBackendConfig | any = {
                storage_account_name    : tasks.getInput("backendAzureRmStorageAccountName", true),
                container_name          : tasks.getInput("backendAzureRmContainerName", true),
                key                     : tasks.getInput("backendAzureRmKey", true),
                resource_group_name     : tasks.getInput("backendAzureRmResourceGroupName", true),
                arm_subscription_id     : tasks.getEndpointDataParameter(backendServiceName, "subscriptionid", true),
                arm_tenant_id           : tasks.getEndpointAuthorizationParameter(backendServiceName, "tenantid", true),
                arm_client_id           : tasks.getEndpointAuthorizationParameter(backendServiceName, "serviceprincipalid", true),
                arm_client_secret       : tasks.getEndpointAuthorizationParameter(backendServiceName, "serviceprincipalkey", true)
            }

            for(var config in backendConfig){
                context.terraform.arg(`-backend-config=${config}=${backendConfig[config]}`);
            }

            let ensureBackendChecked: boolean = tasks.getBoolInput("ensureBackend");
            if(ensureBackendChecked === true){
                let location = tasks.getInput("backendAzureRmResourceGroupLocation", true);
                let sku = tasks.getInput("backendAzureRmStorageAccountSku", true);
                this.ensureBackend(backendConfig, location, sku);
            }
        }
    }

    private ensureBackend(backendConfig: AzureBackendConfig, location: string, sku: string){
        let shell = new CommandPipeline()
            .azLogin(new AzLogin(
                backendConfig.arm_tenant_id,
                backendConfig.arm_client_id,
                backendConfig.arm_client_secret
            ))
            .azAccountSet(new AzAccountSet(
                backendConfig.arm_subscription_id
            ))
            .azGroupCreate(new AzGroupCreate(
                backendConfig.resource_group_name,
                location
            ))
            .azStorageAccountCreate(new AzStorageAccountCreate(
                backendConfig.storage_account_name,
                backendConfig.resource_group_name,
                sku
            ))
            .azStorageContainerCreate(new AzStorageContainerCreate(
                backendConfig.container_name,
                backendConfig.storage_account_name
            ))
            .execute(this.mediator);
    }
}

TerraformRunner.prototype.withAzureRmBackend = function(this: TerraformRunner, mediator: IMediator, backendType?: BackendTypes | undefined): TerraformRunner {
    return this.with((builder) => new TerraformWithAzureRmBackend(builder, mediator, backendType));
}

@injectable()
export class TerraformInitHandler implements IHandleCommandString{
    private readonly mediator: IMediator;
    private readonly log: ILogger;

    constructor(
        @inject(MediatorInterfaces.IMediator) mediator: IMediator,
        @inject(TerraformInterfaces.ILogger) log: ILogger
    ) {
        this.mediator = mediator
        this.log = log;
    }

    public async execute(command: string): Promise<number> {
        let init = new TerraformInit(
            command,            
            tasks.getInput("workingDirectory"),
            tasks.getInput("backendType"),
            tasks.getInput("commandOptions"),
        );

        let loggedProps = {
            "backendType": init.backendType || BackendTypes.local,
            "commandOptionsDefined": init.options !== undefined && init.options !== '' && init.options !== null
        };

        return this.log.command(init, (command: TerraformInit) => this.onExecute(command), loggedProps);
    }

    public async onExecute(command: TerraformInit): Promise<number> {
        return new TerraformRunner(command)
            .withAzureRmBackend(this.mediator, command.backendType)
            .exec();
    }
}