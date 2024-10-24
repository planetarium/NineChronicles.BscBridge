import Web3 from "web3";
import { init } from "@sentry/node";
import { KmsProvider } from "@planetarium/aws-kms-provider";

import { BscBurnEventMonitor } from "./monitors/bsc-burn-event-monitor";
import { HeadlessGraphQLClient } from "./headless-graphql-client";
import { ContractDescription } from "./types/contract-description";
import { IMonitorStateStore } from "./interfaces/monitor-state-store";
import { Sqlite3MonitorStateStore } from "./sqlite3-monitor-state-store";
import { WebClient } from "@slack/web-api";
import { OpenSearchClient } from "./opensearch-client";
import { Configuration } from "./configuration";
import { BscBurnEventObserver } from "./observers/burn-event-observer";
import { KMSNCGSigner } from "./kms-ncg-signer";
import { NCGKMSTransfer } from "./ncg-kms-transfer";
import Decimal from "decimal.js";
import { IExchangeHistoryStore } from "./interfaces/exchange-history-store";
import { Sqlite3ExchangeHistoryStore } from "./sqlite3-exchange-history-store";
import consoleStamp from "console-stamp";
import { Integration } from "./integrations";
import { PagerDutyIntegration } from "./integrations/pagerduty";
import { SlackMessageSender } from "./slack-message-sender";
import {
  FixedExchangeFeeRatioPolicy,
  IExchangeFeeRatioPolicy,
} from "./policies/exchange-fee-ratio";
import { SlackChannel } from "./slack-channel";
import { ethers } from "ethers";
import { SpreadsheetClient } from "./spreadsheet-client";
import { google } from "googleapis";
import { MultiPlanetary } from "./multi-planetary";
import { bscBridgeContractAbi } from "./bsc-bridge-contract-abi";

consoleStamp(console);

process.on("uncaughtException", console.error);

(async () => {
  const GRAPHQL_API_ENDPOINT: string = Configuration.get(
    "GRAPHQL_API_ENDPOINT"
  );
  const NCG_MINTER: string = Configuration.get("NCG_MINTER");
  const KMS_PROVIDER_URL: string = Configuration.get("KMS_PROVIDER_URL");
  // const KMS_PROVIDER_SUB_URL: string = Configuration.get(
  //     "KMS_PROVIDER_SUB_URL"
  // );
  const KMS_PROVIDER_KEY_ID: string = Configuration.get("KMS_PROVIDER_KEY_ID");
  const KMS_PROVIDER_REGION: string = Configuration.get("KMS_PROVIDER_REGION");
  const KMS_PROVIDER_AWS_ACCESSKEY: string = Configuration.get(
    "KMS_PROVIDER_AWS_ACCESSKEY"
  );
  const KMS_PROVIDER_AWS_SECRETKEY: string = Configuration.get(
    "KMS_PROVIDER_AWS_SECRETKEY"
  );
  const KMS_PROVIDER_PUBLIC_KEY: string = Configuration.get(
    "KMS_PROVIDER_PUBLIC_KEY"
  );
  const BSC_BRIDGE_CONTRACT_ADDRESS: string = Configuration.get(
    "BSC_BRIDGE_CONTRACT_ADDRESS"
  );
  const MONITOR_STATE_STORE_PATH: string = Configuration.get(
    "MONITOR_STATE_STORE_PATH"
  );
  const EXCHANGE_HISTORY_STORE_PATH: string = Configuration.get(
    "EXCHANGE_HISTORY_STORE_PATH"
  );
  const MINIMUM_NCG: number = Configuration.get("MINIMUM_NCG", true, "float");
  const MAXIMUM_NCG: number = Configuration.get("MAXIMUM_NCG", true, "float");
  const MAXIMUM_WHITELIST_NCG: number = Configuration.get(
    "MAXIMUM_WHITELIST_NCG",
    true,
    "float"
  );
  const BASE_FEE_CRITERION: number = Configuration.get(
    "BASE_FEE_CRITERION",
    true,
    "float"
  );
  const BASE_FEE: number = Configuration.get("BASE_FEE", true, "float");
  const FEE_RANGE_DIVIDER_AMOUNT: number = Configuration.get(
    "FEE_RANGE_DIVIDER_AMOUNT",
    true,
    "float"
  );

  const FEE_RANGE1_RATIO: number = Configuration.get(
    "FEE_RANGE1_RATIO",
    true,
    "float"
  );
  const FEE_RANGE2_RATIO: number = Configuration.get(
    "FEE_RANGE2_RATIO",
    true,
    "float"
  );

  const SLACK_WEB_TOKEN: string = Configuration.get("SLACK_WEB_TOKEN");
  const FAILURE_SUBSCRIBERS: string = Configuration.get("FAILURE_SUBSCRIBERS");
  const OPENSEARCH_ENDPOINT: string = Configuration.get("OPENSEARCH_ENDPOINT");
  const OPENSEARCH_ENDPOINT_MIGRATION: string = Configuration.get(
    "OPENSEARCH_ENDPOINT_MIGRATION"
  );
  const OPENSEARCH_AUTH: string = Configuration.get("OPENSEARCH_AUTH");
  const OPENSEARCH_INDEX: string =
    Configuration.get("OPENSEARCH_INDEX", false) || "9c-eth-bridge";
  const SLACK_CHANNEL_NAME: string =
    Configuration.get("SLACK_CHANNEL_NAME", false) ||
    "#nine-chronicles-bridge-bot";
  const EXPLORER_ROOT_URL: string = Configuration.get("EXPLORER_ROOT_URL");
  const NCSCAN_URL: string | undefined = Configuration.get("NCSCAN_URL", false);
  const USE_NCSCAN_URL: boolean = Configuration.get(
    "USE_NCSCAN_URL",
    false,
    "boolean"
  );
  const BSCSCAN_ROOT_URL: string = Configuration.get("BSCSCAN_ROOT_URL");
  const SENTRY_DSN: string | undefined = Configuration.get("SENTRY_DSN", false);
  if (SENTRY_DSN !== undefined) {
    init({
      dsn: SENTRY_DSN,
    });
  }

  // Environment Variables for using Google Spread Sheet API
  const SLACK_URL: string = Configuration.get("SLACK_URL");

  const GOOGLE_SPREADSHEET_URL: string = Configuration.get(
    "GOOGLE_SPREADSHEET_URL"
  );
  const GOOGLE_SPREADSHEET_ID: string = Configuration.get(
    "GOOGLE_SPREADSHEET_ID"
  );
  const GOOGLE_CLIENT_EMAIL: string = Configuration.get("GOOGLE_CLIENT_EMAIL");
  const GOOGLE_CLIENT_PRIVATE_KEY: string = Configuration.get(
    "GOOGLE_CLIENT_PRIVATE_KEY"
  );
  const USE_GOOGLE_SPREAD_SHEET: boolean = Configuration.get(
    "USE_GOOGLE_SPREAD_SHEET",
    false,
    "boolean"
  );
  const SHEET_MINT: string = Configuration.get("SHEET_MINT");
  const SHEET_BURN: string = Configuration.get("SHEET_BURN");

  if (BASE_FEE >= BASE_FEE_CRITERION) {
    throw Error(
      `BASE_FEE(value: ${BASE_FEE}) should be less than BASE_FEE_CRITERION(value: ${BASE_FEE_CRITERION})`
    );
  }

  if (BASE_FEE_CRITERION > FEE_RANGE_DIVIDER_AMOUNT) {
    throw Error(
      `BASE_FEE_CRITERION(value: ${BASE_FEE_CRITERION}) should be less than or Equal FEE_RANGE_DIVIDER_AMOUNT(value: ${FEE_RANGE_DIVIDER_AMOUNT})`
    );
  }

  if (FEE_RANGE_DIVIDER_AMOUNT > MAXIMUM_NCG) {
    throw Error(
      `FEE_RANGE_DIVIDER_AMOUNT(value: ${FEE_RANGE_DIVIDER_AMOUNT}) should be less than or Equal MAXIMUM_NCG(value: ${MAXIMUM_NCG})`
    );
  }

  const ncgExchangeFeeRatioPolicy: IExchangeFeeRatioPolicy =
    new FixedExchangeFeeRatioPolicy(
      new Decimal(MAXIMUM_NCG),
      new Decimal(FEE_RANGE_DIVIDER_AMOUNT),
      {
        criterion: new Decimal(BASE_FEE_CRITERION),
        fee: new Decimal(BASE_FEE),
      },
      {
        range1: new Decimal(FEE_RANGE1_RATIO),
        range2: new Decimal(FEE_RANGE2_RATIO),
      }
    );

  const authorize = new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    undefined,
    GOOGLE_CLIENT_PRIVATE_KEY,
    [GOOGLE_SPREADSHEET_URL]
  );
  const googleSheet = google.sheets({
    version: "v4",
    auth: authorize,
  });

  const spreadsheetClient = new SpreadsheetClient(
    googleSheet,
    GOOGLE_SPREADSHEET_ID,
    USE_GOOGLE_SPREAD_SHEET,
    SLACK_URL,
    {
      mint: SHEET_MINT,
      burn: SHEET_BURN,
    },
    ncgExchangeFeeRatioPolicy
  );

  const GAS_TIP_RATIO_STRING: string = Configuration.get(
    "GAS_TIP_RATIO",
    true,
    "string"
  );

  const MAX_GAS_PRICE_STRING: string = Configuration.get(
    "MAX_GAS_PRICE",
    true,
    "string"
  );

  const PAGERDUTY_ROUTING_KEY: string = Configuration.get(
    "PAGERDUTY_ROUTING_KEY",
    true,
    "string"
  );

  const STAGE_HEADLESSES: string[] =
    Configuration.get("STAGE_HEADLESSES").split(",");

  const PLANET_ODIN_ID: string | undefined = Configuration.get(
    "PLANET_ODIN_ID",
    true,
    "string"
  );
  const PLANET_HEIMDALL_ID: string | undefined = Configuration.get(
    "PLANET_HEIMDALL_ID",
    true,
    "string"
  );
  const ODIN_TO_HEIMDALL_VALUT_ADDRESS: string | undefined = Configuration.get(
    "ODIN_TO_HEIMDALL_VALUT_ADDRESS",
    true,
    "string"
  );

  const CONFIRMATIONS = 10;

  const monitorStateStore: IMonitorStateStore =
    await Sqlite3MonitorStateStore.open(MONITOR_STATE_STORE_PATH);
  const exchangeHistoryStore: IExchangeHistoryStore =
    await Sqlite3ExchangeHistoryStore.open(EXCHANGE_HISTORY_STORE_PATH);
  const slackWebClient = new WebClient(SLACK_WEB_TOKEN);
  const opensearchClient = new OpenSearchClient(
    OPENSEARCH_ENDPOINT,
    OPENSEARCH_AUTH,
    OPENSEARCH_INDEX
  );

  const opensearchMigrationClient = new OpenSearchClient(
    OPENSEARCH_ENDPOINT_MIGRATION,
    OPENSEARCH_AUTH,
    OPENSEARCH_INDEX
  );

  const GRAPHQL_REQUEST_RETRY = 5;
  const JWT_SECRET_KEY = Configuration.get("JWT_SECRET_KEY");
  const headlessGraphQLCLient = new HeadlessGraphQLClient(
    GRAPHQL_API_ENDPOINT,
    GRAPHQL_REQUEST_RETRY,
    JWT_SECRET_KEY
  );
  const stageGraphQLClients = STAGE_HEADLESSES.map(
    (endpoint) =>
      new HeadlessGraphQLClient(endpoint, GRAPHQL_REQUEST_RETRY, JWT_SECRET_KEY)
  );
  const integration: Integration = new PagerDutyIntegration(
    PAGERDUTY_ROUTING_KEY
  );
  const kmsProvider = new KmsProvider(KMS_PROVIDER_URL, {
    region: KMS_PROVIDER_REGION,
    keyIds: [KMS_PROVIDER_KEY_ID],
    credential: {
      accessKeyId: KMS_PROVIDER_AWS_ACCESSKEY,
      secretAccessKey: KMS_PROVIDER_AWS_SECRETKEY,
    },
  });
  const web3 = new Web3(kmsProvider);

  const wNCGonBscBridgeContract: ContractDescription = {
    abi: bscBridgeContractAbi,
    address: BSC_BRIDGE_CONTRACT_ADDRESS,
  };

  if (!web3.utils.isAddress(NCG_MINTER)) {
    throw Error(
      "NCG_MINTER variable seems invalid because it is not valid address format."
    );
  }

  const kmsAddresses = await kmsProvider.getAccounts();
  if (kmsAddresses.length != 1) {
    throw Error("NineChronicles.EthBridge is supported only one address.");
  }
  const kmsAddress = kmsAddresses[0];
  console.log(kmsAddress);

  const provider = new ethers.providers.JsonRpcProvider(KMS_PROVIDER_URL);

  const signer = new KMSNCGSigner(KMS_PROVIDER_REGION, KMS_PROVIDER_KEY_ID, {
    accessKeyId: KMS_PROVIDER_AWS_ACCESSKEY,
    secretAccessKey: KMS_PROVIDER_AWS_SECRETKEY,
  });
  const derivedAddress =
    "0x" +
    web3.utils
      .keccak256(
        "0x" +
          Buffer.from(KMS_PROVIDER_PUBLIC_KEY, "base64")
            .toString("hex")
            .slice(2)
      )
      .slice(26);
  if (kmsAddress.toLowerCase() !== derivedAddress.toLowerCase()) {
    throw Error(
      "KMS_PROVIDER_PUBLIC_KEY variable seems invalid because it doesn't match to address from KMS."
    );
  }

  const ncgKmsTransfer = new NCGKMSTransfer(
    [headlessGraphQLCLient, ...stageGraphQLClients],
    kmsAddress,
    KMS_PROVIDER_PUBLIC_KEY,
    [NCG_MINTER],
    signer
  );

  const slackChannel = new SlackChannel(slackWebClient, SLACK_CHANNEL_NAME);
  const slackMessageSender = new SlackMessageSender(slackChannel);
  const planetIds = {
    odin: PLANET_ODIN_ID,
    heimdall: PLANET_HEIMDALL_ID,
  };
  const planetVaultAddress = {
    heimdall: ODIN_TO_HEIMDALL_VALUT_ADDRESS,
  };
  const multiPlanetary = new MultiPlanetary(planetIds, planetVaultAddress);

  const ethereumBurnEventObserver = new BscBurnEventObserver(
    ncgKmsTransfer,
    slackMessageSender,
    opensearchClient,
    spreadsheetClient,
    monitorStateStore,
    exchangeHistoryStore,
    EXPLORER_ROOT_URL,
    NCSCAN_URL,
    USE_NCSCAN_URL,
    BSCSCAN_ROOT_URL,
    integration,
    multiPlanetary,
    FAILURE_SUBSCRIBERS,
    opensearchMigrationClient
  );
  const ethereumBurnEventMonitor = new BscBurnEventMonitor(
    provider,
    wNCGonBscBridgeContract,
    await monitorStateStore.load("bsc"),
    CONFIRMATIONS
  );
  ethereumBurnEventMonitor.attach(ethereumBurnEventObserver);
  ethereumBurnEventMonitor.run();
})().catch((error) => {
  console.error(error);
  process.exit(-1);
});
