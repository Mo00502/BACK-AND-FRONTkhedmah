import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface MoyasarSource {
  type: 'creditcard' | 'applepay' | 'stcpay';
  name?: string;
  number?: string;
  cvc?: string;
  month?: string;
  year?: string;
  token?: string;
  mobile?: string;
}

export interface MoyasarPaymentParams {
  amount: number; // in halalas (SAR * 100)
  currency: string;
  description: string;
  source: MoyasarSource;
  callbackUrl?: string;
  metadata?: Record<string, string>;
}

export interface MoyasarPaymentResponse {
  id: string;
  status: string;
  amount: number;
  currency: string;
  description: string;
  source: any;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class MoyasarService {
  private readonly logger = new Logger(MoyasarService.name);
  private readonly client: AxiosInstance;
  private readonly secretKey: string;

  constructor(private readonly configService: ConfigService) {
    this.secretKey = this.configService.get<string>('MOYASAR_SECRET_KEY');

    this.client = axios.create({
      baseURL: 'https://api.moyasar.com/v1',
      auth: {
        username: this.secretKey,
        password: '',
      },
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  /**
   * Create a payment via Moyasar.
   * Amount is passed in SAR and converted to halalas (x100) internally.
   */
  async createPayment(params: MoyasarPaymentParams): Promise<MoyasarPaymentResponse> {
    try {
      const response = await this.client.post('/payments', {
        amount: Math.round(params.amount * 100), // Convert SAR → halalas
        currency: params.currency || 'SAR',
        description: params.description,
        source: params.source,
        callback_url: params.callbackUrl,
        metadata: params.metadata,
      });

      this.logger.log(`Moyasar payment created: id=${response.data.id} status=${response.data.status}`);
      return response.data;
    } catch (error) {
      const message = error.response?.data?.message || error.message;
      this.logger.error(`Moyasar createPayment failed: ${message}`, error.response?.data);
      throw new BadRequestException(`Payment gateway error: ${message}`);
    }
  }

  /**
   * Verify/fetch a payment by Moyasar payment ID.
   */
  async verifyPayment(paymentId: string): Promise<MoyasarPaymentResponse> {
    try {
      const response = await this.client.get(`/payments/${paymentId}`);
      return response.data;
    } catch (error) {
      const message = error.response?.data?.message || error.message;
      this.logger.error(`Moyasar verifyPayment failed: id=${paymentId} error=${message}`);
      throw new BadRequestException(`Failed to verify payment: ${message}`);
    }
  }

  /**
   * Issue a full or partial refund for a payment.
   * amount in SAR (converted to halalas internally).
   */
  async refundPayment(paymentId: string, amount: number): Promise<void> {
    try {
      await this.client.post(`/payments/${paymentId}/refund`, {
        amount: Math.round(amount * 100),
      });
      this.logger.log(`Moyasar refund issued: paymentId=${paymentId} amount=${amount}`);
    } catch (error) {
      const message = error.response?.data?.message || error.message;
      this.logger.error(`Moyasar refund failed: id=${paymentId} error=${message}`);
      throw new BadRequestException(`Refund failed: ${message}`);
    }
  }
}
