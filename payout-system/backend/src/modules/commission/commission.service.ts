import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface CommissionResult {
  totalAmount: number;
  platformFee: number;
  providerAmount: number;
  vatAmount: number;
  commissionRate: number;
}

@Injectable()
export class CommissionService {
  private readonly defaultCommissionRate: number;
  private readonly vatRate: number;

  constructor(private readonly configService: ConfigService) {
    this.defaultCommissionRate = parseFloat(
      this.configService.get<string>('PLATFORM_COMMISSION_RATE', '0.15'),
    );
    this.vatRate = parseFloat(
      this.configService.get<string>('VAT_RATE', '0.15'),
    );
  }

  /**
   * Calculate commission breakdown for an order.
   *
   * Formula:
   *  platformFee    = totalAmount * commissionRate
   *  vatAmount      = platformFee * vatRate        (VAT applied only on platform fee per Saudi law)
   *  providerAmount = totalAmount - platformFee - vatAmount
   *
   * Example with SAR 1000:
   *  platformFee    = 150.00
   *  vatAmount      = 22.50
   *  providerAmount = 827.50
   */
  calculateCommission(totalAmount: number, serviceType?: string): CommissionResult {
    // Future: serviceType can determine tiered rates
    const commissionRate = this.getCommissionRate(serviceType);

    const raw = {
      platformFee: totalAmount * commissionRate,
    };

    const platformFee = this.round2(raw.platformFee);
    const vatAmount = this.round2(platformFee * this.vatRate);
    const providerAmount = this.round2(totalAmount - platformFee - vatAmount);

    return {
      totalAmount: this.round2(totalAmount),
      platformFee,
      providerAmount,
      vatAmount,
      commissionRate,
    };
  }

  private getCommissionRate(serviceType?: string): number {
    // Tiered rates by service type
    const rates: Record<string, number> = {
      consultation: 0.1,
      equipment: 0.1,
      tender: 0.02,
    };

    if (serviceType && rates[serviceType]) {
      return rates[serviceType];
    }

    return this.defaultCommissionRate;
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
