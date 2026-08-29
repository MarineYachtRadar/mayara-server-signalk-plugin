import { Type, type Static } from 'typebox';
export declare const ConfigSchema: Type.TObject<{
    managedContainer: Type.TBoolean;
    mayaraVersion: Type.TString;
    mayaraArgs: Type.TArray<Type.TString>;
    requestSignalkToken: Type.TBoolean;
    host: Type.TString;
    port: Type.TNumber;
    secure: Type.TBoolean;
    directGuiUrl: Type.TBoolean;
    discoveryPollInterval: Type.TNumber;
    reconnectInterval: Type.TNumber;
    telemetry: Type.TBoolean;
}>;
export type Config = Static<typeof ConfigSchema>;
export declare const SCHEMA_DEFAULTS: Config;
//# sourceMappingURL=schema.d.ts.map