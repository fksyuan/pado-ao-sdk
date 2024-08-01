import Data from 'contracts/AO/Data';
import Fee from 'contracts/AO/Fee';
import Helper from 'contracts/AO/Helper';
import Task from 'contracts/AO/Task';
import Worker from 'contracts/AO/Worker';
import { AOCRED_PROCESS_ID, COMPUTELIMIT, DEFAULTENCRYPTIONSCHEMA, MEMORYLIMIT, TASKS_PROCESS_ID, WAR_PROCESS_ID } from '../config';
import { KeyInfo, StorageType, type CommonObject, type EncryptionSchema, type PriceInfo } from '../index.d';
import BaseContract from './BaseContract';


export default class ArweaveContract extends BaseContract {
  worker: any;
  data: any;
  task: any;
  fee: any;
  helper: any;
  userKey: KeyInfo;
  constructor(chainName: ChainName, storageType: StorageType) {
    super(chainName, storageType);
    this.worker = new Worker();
    this.data = new Data();
    this.task = new Task();
    this.fee = new Fee();
    this.helper = new Helper();
    this.userKey = { pk: '', sk: '' };
  }

  /**
   * Encrypt data and upload encrypted data to decentralized storage blockchains such as Arweave and Filecoin.
   *
   * @param data - plain data need to encrypt and upload
   * @param dataTag - the data meta info object
   * @param priceInfo - The data price symbol(symbol is optional, default is wAR) and price. Currently only wAR(the Wrapped AR in AO) is supported, with a minimum price unit of 1 (1 means 0.000000000001 wAR).
   * @param wallet - The ar wallet json object, this wallet must have AR Token. Pass `window.arweaveWallet` in a browser
   * @param encryptionSchema EncryptionSchema
   * @param extParam - The extParam object, which can be used to pass additional parameters to the upload process
   *                    - uploadParam : The uploadParam object, which can be used to pass additional parameters to the upload process
   *                        - storageType : The storage type, default is ARWEAVE
   *                        - symbolTag :  The tag corresponding to the token used for payment. ref: https://web3infra.dev/docs/arseeding/sdk/arseeding-js/getTokenTag
   * @returns The uploaded encrypted data id
   */
  async submitData(
    data: Uint8Array,
    dataTag: CommonObject,
    priceInfo: PriceInfo,
    wallet: any,
    encryptionSchema: EncryptionSchema = DEFAULTENCRYPTIONSCHEMA
  ) {
    const [policy, publicKeys] = await this.data.prepareRegistry(encryptionSchema);
    const encryptData = this.encryptData(data, policy, publicKeys);
    // if (!encryptedData) {
    //   throw new Error('The encrypted Data to be uploaded can not be empty');
    // }
    let transactionId = await this.storage.submitData(encryptData.enc_msg, wallet);
    dataTag['storageType'] = this.storage.StorageType;

    const txData = {
      policy: encryptData.policy,
      nonce: encryptData.nonce,
      transactionId: transactionId,
      encSks: encryptData.enc_sks
    };
    const dataTagStr = JSON.stringify(dataTag);
    const priceInfoStr = JSON.stringify(priceInfo);
    const txDataStr = JSON.stringify(txData);
    const computeNodes = policy.names;
    const signer = await this.getSigner(wallet);
    const dataId = this.data.register(dataTagStr, priceInfoStr, txDataStr, computeNodes, signer);
    return dataId;
  }

  async getDataList(dataStatus: string = 'Valid') {
    const res = await this.data.allData(dataStatus);
    return res;
  }
  async getDataById(dataId: string) {
    const res = await this.data.getDataById(dataId);
    return res;
  }

  async submitTask(taskType: string, wallet: any, dataId: string) {
    const key = await this.generateKey();
    this.userKey = key;

    let encData = await this.data.getDataById(dataId);

    encData = JSON.parse(encData);
    const exData = JSON.parse(encData.data);
    const nodeNames = exData.policy.names;
    const priceObj = JSON.parse(encData.price);
    const symbol = priceObj.symbol;
    // TODO-ysm
    const supportSymbols = ['AOCRED', 'wAR'];
    const supportSymbolFromAddressMap = {
      AOCRED: AOCRED_PROCESS_ID,
      wAR: WAR_PROCESS_ID
    };
    if (!supportSymbols.includes(symbol)) {
      throw new Error(`Only support ${supportSymbols.join('/')} now!`);
    }
    const dataPrice = priceObj.price;
    //get node price

    const nodePrice = await this.fee.fetchComputationPrice(symbol);
    const totalPrice = Number(dataPrice) + Number(nodePrice) * nodeNames.length;
    const signer = await this.getSigner(wallet);

    try {
      const from = supportSymbolFromAddressMap[symbol as keyof typeof supportSymbolFromAddressMap];
      await this.helper.transfer(from, TASKS_PROCESS_ID, totalPrice.toString(), signer);
    } catch (err) {
      if (err === 'Insufficient Balance!') {
        throw new Error(
          'Insufficient Balance! Please ensure that your wallet balance is greater than ' + totalPrice + symbol
        );
      } else {
        throw err;
      }
    }

    let inputData = { dataId, consumerPk: key.pk };
    // const TASKTYPE= 'ZKLHEDataSharing'
    const taskId = await this.task.submit(
      taskType,
      dataId as string,
      JSON.stringify(inputData),
      COMPUTELIMIT,
      MEMORYLIMIT,
      nodeNames,
      signer
    );
    return taskId;
  }

  async getTaskResult(taskId: string, timeout: number = 10000): Promise<Uint8Array> {
    const taskStr = await this._getCompletedTaskPromise(taskId, timeout);
    const task = JSON.parse(taskStr);
    if (task.verificationError) {
      throw task.verificationError;
    }

    let dataId = JSON.parse(task.inputData).dataId;
    let encData = await this.data.getDataById(dataId);
    encData = JSON.parse(encData);
    let exData = JSON.parse(encData.data);
    // const dataTag = JSON.parse(encData.dataTag);
    // const storageType = dataTag?.storageType;
    const t = exData.policy.t;
    const n = exData.policy.n;
    let chosenIndices = [];
    let reencChosenSks = [];
    for (let i = 0; i < n; i++) {
      let name = exData.policy.names[i];

      if (task.result && task.result[name]) {
        let index = exData.policy.indices[i];
        chosenIndices.push(index);

        const reencSksObj = JSON.parse(task.result[name]);
        reencChosenSks.push(reencSksObj.reenc_sk);
      }
      if (chosenIndices.length >= t) {
        break;
      }
    }
    if (chosenIndices.length < t) {
      throw `Insufficient number of chosen nodes, expect at least ${t}, actual ${chosenIndices.length}`;
    }
    let encMsg = await this.storage.getData(exData.transactionId);

    // TODO-ysm
    const res = this.decrypt(reencChosenSks, this.userKey.sk, exData.nonce, encMsg, chosenIndices);
    return new Uint8Array(res.msg);
  }

  private async _getCompletedTaskPromise(taskId: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const tick = async () => {
        const timeGap = performance.now() - start;
        const taskStr = await this.task.getCompletedTasksById(taskId);
        const task = JSON.parse(taskStr);
        if (task.id) {
          resolve(taskStr);
        } else if (timeGap > timeout) {
          reject('timeout');
        } else {
          setTimeout(tick, 500);
        }
      };
      tick();
    });
  }
}